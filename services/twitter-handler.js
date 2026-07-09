// ═══════════════════════════════════════════════════════════
// Twitter Handler — shared ingestion pipeline with audit logging
// Every tweet is logged to twitter_audit_log at every decision point.
// ═══════════════════════════════════════════════════════════

const { extractPickFromTweet, parseBetText, evaluateTweet, validateParsedBet, reclassifySport } = require('./ai');
const { db, getOrCreateCapper, createBetWithLegs, updateLastTweetId, logTweetAudit } = require('./database');
const { sendStagingEmbed } = require('./warRoom');
const { recordStage, recordDrop, recordError, makeIngestId } = require('./pipeline-events');
const slateResplit = require('./slateResplit');

const delay = ms => new Promise(r => setTimeout(r, ms));

function extractImageUrls(tweet) {
  const urls = [];
  // twitterapi.io: extendedEntities.media[].media_url_https where type === 'photo'
  const extMedia = tweet.extendedEntities?.media || tweet.extended_entities?.media || [];
  if (Array.isArray(extMedia)) {
    for (const m of extMedia) {
      if (m.type === 'photo' && m.media_url_https) urls.push(m.media_url_https);
      else if (m.type === 'photo' && m.media_url) urls.push(m.media_url);
    }
  }
  // apitwitter.com format: tweet.media[].url
  if (urls.length === 0 && Array.isArray(tweet.media)) {
    for (const m of tweet.media) {
      if (m.type === 'photo' && m.url) urls.push(m.url);
      else if (m.media_url_https) urls.push(m.media_url_https);
    }
  }
  // Legacy: entities.media
  const legacyMedia = tweet.entities?.media || [];
  if (urls.length === 0 && Array.isArray(legacyMedia)) {
    for (const m of legacyMedia) {
      const url = m.media_url_https || m.media_url || m.url;
      if (url) urls.push(url);
    }
  }
  // Fallback: tweet.photos
  if (urls.length === 0 && Array.isArray(tweet.photos)) {
    for (const p of tweet.photos) { if (p.url) urls.push(p.url); }
  }
  return urls;
}

// ── F-12: content-window repost dedup ───────────────────────
// One source account (bobby__tracker) re-posts the SAME pick across
// multiple separate tweets the same day — each a DISTINCT real tweet id,
// gaps observed 6s–3.25h. The fingerprint dedup in createBetWithLegs hashes
// the per-message id into the key, so same-content/different-tweet reposts
// hash differently and BOTH get saved. This gate ignores the tweet id and
// collapses reposts inside a 12h window.
//
// GUARDRAIL: the same pick TEXT legitimately recurs across DIFFERENT days
// for different matches (e.g. "cerundolo s1 ml" 23 days apart). Observed dup
// gaps are all <= 3.25h; legit repeats are >= 2 days — so a 12h window keeps
// the legit repeats while collapsing the reposts.
//
// Normalize for comparison: lowercase, collapse every run of non-alphanumeric
// chars to a single space, trim. This matches the forensic grouping that
// identified the dups — NOT a whitespace-only collapse.
function normalizeForDedup(description) {
  return String(description || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Returns a prior bet row { id, description, odds } if an equivalent twitter
// bet from the same capper exists inside the 12h window, else null. Odds match
// is null-aware (null matches null; `|| null` mirrors createBet's storage, so
// 0/NaN collapse to null exactly as stored). bets.created_at is the schema
// default datetime('now') string (YYYY-MM-DD HH:MM:SS), so the window filter
// is the comparable datetime('now','-12 hours') — verified against migrations/
// 001_initial_schema.sql (createBet never sets created_at explicitly).
function findRecentRepost({ capperId, description, odds, betType }) {
  const norm = normalizeForDedup(description);
  if (!capperId || !norm) return null;
  const wantOdds = odds || null;
  const candidates = db.prepare(`
    SELECT id, description, odds
    FROM bets
    WHERE capper_id = ?
      AND bet_type = ?
      AND source IN ('twitter_text', 'twitter_vision')
      AND created_at >= datetime('now', '-12 hours')
  `).all(capperId, betType || 'straight');
  for (const row of candidates) {
    if (normalizeForDedup(row.description) !== norm) continue;
    if ((row.odds || null) !== wantOdds) continue;
    return row;
  }
  return null;
}

async function handleTwitterWebhookPayload(payload, client) {
  const { handle, tweets } = payload;
  if (!handle || !Array.isArray(tweets) || tweets.length === 0) {
    return { staged: 0, skipped: 0, aiCalls: 0 };
  }

  const cleanHandle = handle.replace(/<[^>]*>/g, '').replace(/@/g, '').trim().toLowerCase();
  const displayName = payload.displayName || cleanHandle;

  console.log(`[TwitterHandler] Processing ${tweets.length} tweet(s) from @${cleanHandle}...`);

  let staged = 0;
  let skipped = 0;
  let aiCalls = 0;

  for (const tweet of tweets) {
    const tweetId = String(tweet.id || tweet.tweet_id || tweet.rest_id || tweet.id_str || '');
    const text = tweet.text || tweet.full_text || tweet.tweetText || '';
    const imageUrls = extractImageUrls(tweet);
    const hasImages = imageUrls.length > 0;
    const tweetUrl = tweetId ? `https://x.com/${cleanHandle}/status/${tweetId}` : '';
    const auditBase = { tweet_id: tweetId, handle: cleanHandle, tweet_text: text, tweet_url: tweetUrl, has_media: hasImages, posted_at: tweet.created_at || null };
    const ingestId = makeIngestId('twitter', tweetId || `${cleanHandle}_${Date.now()}`);

    try {
      if (!tweetId || !text) {
        recordDrop({ ingestId, sourceType: 'twitter', sourceRef: tweetId, stage: 'DROPPED', dropReason: 'PRE_FILTER_NO_BET_CONTENT', payload: { reason: 'missing_id_or_text', handle: cleanHandle } });
        continue;
      }

      recordStage({ ingestId, sourceType: 'twitter', sourceRef: tweetId, stage: 'RECEIVED', eventType: 'STAGE_ENTER', payload: { handle: cleanHandle, textLen: text.length, imageCount: imageUrls.length } });

      // Log: fetched
      logTweetAudit({ ...auditBase, stage: 'fetched', reason: `${text.length} chars, ${imageUrls.length} img(s)` });

      // Dedup
      const exists = db.prepare('SELECT tweet_id FROM processed_tweets WHERE tweet_id = ?').get(tweetId);
      if (exists) {
        logTweetAudit({ ...auditBase, stage: 'deduped', reason: 'Already in processed_tweets' });
        recordDrop({ ingestId, sourceType: 'twitter', sourceRef: tweetId, stage: 'DROPPED', dropReason: 'DUPLICATE_IMAGE', payload: { reason: 'processed_tweets_dedup', handle: cleanHandle } });
        skipped++;
        continue;
      }
      db.prepare('INSERT OR IGNORE INTO processed_tweets (tweet_id) VALUES (?)').run(tweetId);

      recordStage({ ingestId, sourceType: 'twitter', sourceRef: tweetId, stage: 'AUTHORIZED', eventType: 'STAGE_ENTER', payload: { handle: cleanHandle } });

      // RT filter (twitterapi.io uses retweeted_tweet, apitwitter.com uses isRetweet)
      if (tweet.retweeted_tweet || tweet.isRetweet || text.startsWith('RT @')) {
        logTweetAudit({ ...auditBase, stage: 'filtered_rt', reason: 'Retweet detected' });
        recordDrop({ ingestId, sourceType: 'twitter', sourceRef: tweetId, stage: 'DROPPED', dropReason: 'BOUNCER_REJECTED', payload: { filter: 'retweet', handle: cleanHandle } });
        continue;
      }

      // Reply filter
      if (tweet.isReply) {
        logTweetAudit({ ...auditBase, stage: 'filtered_reply', reason: 'Direct reply' });
        recordDrop({ ingestId, sourceType: 'twitter', sourceRef: tweetId, stage: 'DROPPED', dropReason: 'BOUNCER_REJECTED', payload: { filter: 'reply', handle: cleanHandle } });
        continue;
      }

      console.log(`[TwitterHandler] @${cleanHandle}: "${text.slice(0, 60)}..." | ${imageUrls.length} img(s)`);

      // ── Pre-filter: ALWAYS check for settled markers (even with images) ──
      const preCheck = evaluateTweet(text);
      if (preCheck === 'reject_settled') {
        logTweetAudit({ ...auditBase, stage: 'bouncer_rejected', reason: 'All picks marked ✅ — settled recap' });
        recordDrop({ ingestId, sourceType: 'twitter', sourceRef: tweetId, stage: 'DROPPED', dropReason: 'PRE_FILTER_NO_BET_CONTENT', payload: { filter: 'evaluateTweet_reject_settled', handle: cleanHandle } });
        continue;
      }
      // Only reject "no structure" for text-only tweets — images go to Vision
      let structureDetected = false;
      if (!hasImages && preCheck === 'reject_recap') {
        logTweetAudit({ ...auditBase, stage: 'bouncer_rejected', reason: 'No betting structure found (pre-filter)' });
        recordDrop({ ingestId, sourceType: 'twitter', sourceRef: tweetId, stage: 'DROPPED', dropReason: 'PRE_FILTER_NO_BET_CONTENT', payload: { filter: 'evaluateTweet_reject_recap', handle: cleanHandle } });
        continue;
      }
      structureDetected = hasImages || (preCheck === 'valid');
      if (hasImages) recordStage({ ingestId, sourceType: 'twitter', sourceRef: tweetId, stage: 'EXTRACTED', eventType: 'STAGE_ENTER', payload: { imageCount: imageUrls.length } });

      await delay(3000);
      aiCalls++;

      let pick = null;
      let legs = [];

      try {
        if (hasImages) {
          console.log(`[TwitterHandler] Image → Vision AI`);
          const visionPrompt = `Tweet from @${displayName}: "${text}"\n\nRead the attached betting slip image and extract all bets. If the image shows "SGP", "Same Game Parlay", "Parlay", or multiple legs, return bet_type "parlay" with ALL legs in the legs array.`;
          // Thread tweetId + imageUrl so the Gemma vision fallback can log
          // any vision_failures row against the originating tweet.
          const parsed = await parseBetText(visionPrompt, imageUrls[0], { tweetId, imageUrl: imageUrls[0] });

          if (parsed && parsed.bets?.length > 0 && parsed.is_bet !== false && parsed.type !== 'ignore') {
            const bet = parsed.bets[0];
            // event_date rides along: the vision prompt extracts the slip's
            // printed date/time verbatim (ai.js EVENT DATE/TIME rule) and
            // normalizeEventDateForStorage resolves/guards it at insert.
            // Dropping it here is why twitter_vision (the largest source
            // bucket) was 100% NULL — see docs/diagnosis/EVENT_DATE_DIAGNOSIS.
            pick = { sport: bet.sport || 'Unknown', type: bet.bet_type || 'straight', description: bet.description, odds: bet.odds ? String(bet.odds) : null, units: bet.units || 1, event_date: bet.event_date || null, legs: bet.legs || [], is_ladder: bet.is_ladder || false, ladder_step: bet.ladder_step || 0 };
            legs = bet.legs || [];
            if (/\b(sgp|same\s*game\s*parlay)\b/i.test(text) && pick.type === 'straight') pick.type = 'parlay';
            recordStage({ ingestId, sourceType: 'twitter', sourceRef: tweetId, stage: 'PARSED', eventType: 'STAGE_ENTER', payload: { source: 'vision', legCount: legs.length, betType: pick.type } });
          } else if (parsed?.type === 'result' || parsed?.type === 'untracked_win') {
            logTweetAudit({ ...auditBase, stage: 'bouncer_rejected', reason: `Vision detected ${parsed.type} — not a new bet` });
            recordDrop({ ingestId, sourceType: 'twitter', sourceRef: tweetId, stage: 'DROPPED', dropReason: 'PRE_FILTER_NO_BET_CONTENT', payload: { filter: 'vision_' + parsed.type, handle: cleanHandle } });
            continue;
          } else {
            pick = await extractPickFromTweet(text, displayName);
            if (pick) {
              legs = pick.legs || [];
              recordStage({ ingestId, sourceType: 'twitter', sourceRef: tweetId, stage: 'PARSED', eventType: 'STAGE_ENTER', payload: { source: 'text_fallback', legCount: legs.length } });
            }
          }
        } else {
          pick = await extractPickFromTweet(text, displayName);
          if (pick) {
            legs = pick.legs || [];
            recordStage({ ingestId, sourceType: 'twitter', sourceRef: tweetId, stage: 'PARSED', eventType: 'STAGE_ENTER', payload: { source: 'text', legCount: legs.length } });
          }
        }
      } catch (aiErr) {
        if (aiErr.status === 429 || String(aiErr.message).includes('429')) {
          logTweetAudit({ ...auditBase, stage: 'error', reason: `AI 429 rate limit` });
          recordError({ ingestId, sourceType: 'twitter', sourceRef: tweetId, stage: 'EXTRACTED', error: aiErr, payload: { reason: 'ai_rate_limit' } });
          await delay(10000);
          continue;
        }
        logTweetAudit({ ...auditBase, stage: 'error', reason: `AI error: ${aiErr.message}` });
        recordError({ ingestId, sourceType: 'twitter', sourceRef: tweetId, stage: 'EXTRACTED', error: aiErr, payload: { handle: cleanHandle } });
        if (hasImages && !pick) {
          try {
            pick = await extractPickFromTweet(text, displayName);
            if (pick) legs = pick.legs || [];
          } catch (_) {}
        }
        if (!pick) {
          recordDrop({ ingestId, sourceType: 'twitter', sourceRef: tweetId, stage: 'DROPPED', dropReason: 'VISION_EXTRACTION_FAILED', payload: { aiError: aiErr.message?.slice(0, 120) } });
          continue;
        }
      }

      if (!pick) {
        // ── Escape hatch: if structure was detected but AI said NULL, force-stage for human review ──
        if (structureDetected) {
          console.warn(`[TwitterHandler] ESCAPE HATCH: structure detected but AI returned NULL — force-staging for review`);
          logTweetAudit({ ...auditBase, stage: 'bouncer_valid', reason: 'ESCAPE HATCH: structure detected, AI returned NULL — forced to review' });
          pick = { sport: 'Unknown', type: 'straight', description: text.slice(0, 200), odds: null, units: 1, legs: [], is_ladder: false, ladder_step: 0 };
          recordStage({ ingestId, sourceType: 'twitter', sourceRef: tweetId, stage: 'PARSED', eventType: 'STAGE_ENTER', payload: { source: 'escape_hatch' } });
        } else {
          logTweetAudit({ ...auditBase, stage: 'bouncer_rejected', reason: 'AI returned NULL — not a bet' });
          recordDrop({ ingestId, sourceType: 'twitter', sourceRef: tweetId, stage: 'DROPPED', dropReason: 'PARSER_NO_LEGS', payload: { reason: 'ai_returned_null', handle: cleanHandle } });
          continue;
        }
      }

      // Sport reclassification — catch misclassified sports
      if (pick.sport) pick.sport = reclassifySport(pick.sport, pick.description);

      // Bouncer accepted — now validate against hallucination.
      // hasMedia uses the already-normalized `hasImages` from extractImageUrls()
      // which handles twitterapi.io, apitwitter.com, and legacy media shapes.
      const validation = validateParsedBet(pick, text, { hasMedia: hasImages });
      if (!validation.valid) {
        console.warn(`[TwitterHandler] HALLUCINATION BLOCKED: ${validation.reason} | ${validation.issues.join('; ')}`);
        logTweetAudit({ ...auditBase, stage: 'bouncer_rejected', reason: `Hallucination: ${validation.reason} — ${validation.issues.join('; ')}` });
        const mappedReason = validation.reason === 'leg_sport_mismatch' ? 'VALIDATOR_SPORT_MISMATCH'
          : validation.reason === 'entity_mismatch' ? 'VALIDATOR_ENTITY_MISMATCH'
          : 'BOUNCER_REJECTED';
        recordDrop({ ingestId, sourceType: 'twitter', sourceRef: tweetId, stage: 'DROPPED', dropReason: mappedReason, payload: { validator: validation.reason, issues: validation.issues, description: (pick.description || '').slice(0, 120) } });
        continue;
      }

      recordStage({ ingestId, sourceType: 'twitter', sourceRef: tweetId, stage: 'VALIDATED', eventType: 'STAGE_ENTER', payload: { betType: pick.type, sport: pick.sport } });
      logTweetAudit({ ...auditBase, stage: 'bouncer_valid', reason: `${pick.type}: "${(pick.description || '').slice(0, 80)}"` });

      if (/\b(sgp|same\s*game\s*parlay)\b/i.test(text) && pick.type !== 'parlay') pick.type = 'parlay';

      const capper = getOrCreateCapper(`twitter_${cleanHandle}`, displayName, null);
      if (!capper || !capper.id) {
        recordDrop({ ingestId, sourceType: 'twitter', sourceRef: tweetId, stage: 'DROPPED', dropReason: 'CAPPER_UNRESOLVED', payload: { handle: cleanHandle } });
        continue;
      }
      const sourceUrl = tweetUrl;
      const betSource = hasImages ? 'twitter_vision' : 'twitter_text';

      // Ladder handling
      if (pick.is_ladder && Array.isArray(pick.ladder_steps) && pick.ladder_steps.length > 1) {
        const ladderBets = [];
        for (const step of pick.ladder_steps) {
          // F-12: per-step content-window dedup (ladder steps save as straights)
          const stepOdds = step.odds ? parseInt(step.odds, 10) : null;
          const priorStep = findRecentRepost({ capperId: capper.id, description: step.description, odds: stepOdds, betType: 'straight' });
          if (priorStep) {
            logTweetAudit({ ...auditBase, stage: 'deduped', reason: `Repost (12h) — ladder step matches bet ${priorStep.id}` });
            recordDrop({ ingestId, sourceType: 'twitter', sourceRef: tweetId, stage: 'DROPPED', dropReason: 'DUPLICATE_REPOST', payload: { window: '12h', handle: cleanHandle, prior_bet_id: priorStep.id, ladder_step: step.ladder_step || 0 } });
            continue;
          }
          // event_date: a ladder's steps ride the same slip/game, so each step
          // inherits the pick-level extracted date (undefined on the text path
          // → write gate stores NULL, byte-identical to before).
          const saved = createBetWithLegs({ capper_id: capper.id, sport: pick.sport || 'Unknown', bet_type: 'straight', description: step.description, odds: stepOdds, units: step.units || 1, event_date: pick.event_date || null, source: betSource, source_url: sourceUrl, source_tweet_id: tweetId, source_tweet_handle: cleanHandle, raw_text: text.slice(0, 500), review_status: 'needs_review', is_ladder: 1, ladder_step: step.ladder_step || 0 }, []);
          if (saved && !saved._deduped) ladderBets.push(saved);
        }
        if (ladderBets.length > 0 && client) {
          try {
            const { sendLadderEmbed } = require('./warRoom');
            await sendLadderEmbed(client, ladderBets, displayName, sourceUrl, pick.sport);
          } catch (_) {}
          staged += ladderBets.length;
        }
        for (const lb of ladderBets) {
          recordStage({ ingestId, betId: lb.id, sourceType: 'twitter', sourceRef: tweetId, stage: 'STAGED', eventType: 'STAGE_EXIT', payload: { pipeline: 'twitter_ladder', step: lb.ladder_step } });
        }
        logTweetAudit({ ...auditBase, stage: 'saved', reason: `Ladder: ${ladderBets.length} steps`, bet_id: ladderBets[0]?.id });
        updateLastTweetId(cleanHandle, tweetId);
        continue;
      }

      // ── Slate re-split (gated: SLATE_RESPLIT_MODE off|shadow|cutover) ──────────
      // A mixed-sport recap SHEET (independently-staked picks) that Vision
      // collapsed into ONE dominant-sport parlay (bet 8436c0c7 — every leg incl.
      // the MMA fighters stamped Soccer, per-pick stakes lost). off: no-op.
      // shadow: measure only (emits slate_resplit_shadow; the parlay still stages
      // as today — zero behavior change). cutover: re-split into per-pick
      // straights with per-pick sport (ITD/finish→MMA, nations→Soccer, else
      // inherits the vision sport low-confidence) and per-pick units recovered
      // from the raw tweet text. See services/slateResplit.js + docs diagnosis.
      if (slateResplit.MODE !== 'off') {
        const resplit = slateResplit.applySlateResplit({
          pick, rawText: text, ingestId, sourceRef: tweetId, recordStageFn: recordStage,
        });
        if (slateResplit.MODE === 'cutover' && resplit.isSheet && resplit.picks.length >= 2) {
          const sheetBets = [];
          for (const p of resplit.picks) {
            // Per-pick F-12 content-window dedup (sheet picks save as straights).
            const priorPick = findRecentRepost({ capperId: capper.id, description: p.description, odds: p.odds ?? null, betType: 'straight' });
            if (priorPick) {
              recordDrop({ ingestId, sourceType: 'twitter', sourceRef: tweetId, stage: 'DROPPED', dropReason: 'DUPLICATE_REPOST', payload: { window: '12h', handle: cleanHandle, prior_bet_id: priorPick.id, resplit: true } });
              continue;
            }
            // event_date: re-split picks inherit the parent slip's extracted
            // date — the same value the un-split parlay would have stored, so
            // the re-split is date-neutral vs. staging the parlay as-is.
            const saved = createBetWithLegs({ capper_id: capper.id, sport: p.sport || pick.sport || 'Unknown', bet_type: 'straight', description: p.description, odds: p.odds ?? null, units: p.units || 1, event_date: pick.event_date || null, source: betSource, source_url: sourceUrl, source_tweet_id: tweetId, source_tweet_handle: cleanHandle, raw_text: (p.description || text).slice(0, 500), review_status: 'needs_review' }, []);
            if (saved && !saved._deduped) sheetBets.push(saved);
          }
          for (const sb of sheetBets) {
            recordStage({ ingestId, betId: sb.id, sourceType: 'twitter', sourceRef: tweetId, stage: 'STAGED', eventType: 'STAGE_EXIT', payload: { pipeline: 'twitter_slate_resplit', sport: sb.sport } });
          }
          if (sheetBets.length > 0) {
            if (client) {
              for (const sb of sheetBets) { try { await sendStagingEmbed(client, sb, displayName, sourceUrl); } catch (_) { /* embed best-effort */ } }
            }
            staged += sheetBets.length;
            logTweetAudit({ ...auditBase, stage: 'saved', reason: `Slate re-split: ${sheetBets.length} straights`, bet_id: sheetBets[0]?.id });
          }
          updateLastTweetId(cleanHandle, tweetId);
          continue;
        }
      }

      // F-12: content-window repost dedup (ignores tweet id) — drop a same-capper
      // same-content/same-odds repost inside 12h; legit >= 2-day repeats fall
      // outside the window and still save. Mirrors the per-step ladder gate above.
      const normalOdds = pick.odds ? parseInt(pick.odds, 10) : null;
      const priorRepost = findRecentRepost({ capperId: capper.id, description: pick.description, odds: normalOdds, betType: pick.type || 'straight' });
      if (priorRepost) {
        logTweetAudit({ ...auditBase, stage: 'deduped', reason: `Repost (12h) — matches bet ${priorRepost.id}` });
        recordDrop({ ingestId, sourceType: 'twitter', sourceRef: tweetId, stage: 'DROPPED', dropReason: 'DUPLICATE_REPOST', payload: { window: '12h', handle: cleanHandle, prior_bet_id: priorRepost.id } });
        updateLastTweetId(cleanHandle, tweetId);
        continue;
      }

      // Normal bet. `wager`: the P1 dollar-stake correction (services/ai.js
      // reassignDollarStakeUnits) moves a mis-parsed "$5,000" out of units into
      // pick.wager; persist it so the dollar stake is recorded (units stays sane).
      // `event_date`: present only on the vision path (pick rebuilt from the
      // parseBetText bet above); the text path (extractPickFromTweet) has no
      // date field in its schema → undefined → write gate stores NULL.
      const saved = createBetWithLegs({ capper_id: capper.id, sport: pick.sport || 'Unknown', bet_type: pick.type || 'straight', description: pick.description, odds: normalOdds, units: pick.units || 1, wager: pick.wager ?? null, event_date: pick.event_date || null, source: betSource, source_url: sourceUrl, source_tweet_id: tweetId, source_tweet_handle: cleanHandle, raw_text: text.slice(0, 500), review_status: 'needs_review', is_ladder: pick.is_ladder || false, ladder_step: pick.ladder_step || 0 }, legs);

      if (saved && !saved._deduped) {
        if (client) {
          try { await sendStagingEmbed(client, saved, displayName, sourceUrl); } catch (_) {}
        }
        staged++;
        recordStage({ ingestId, betId: saved.id, sourceType: 'twitter', sourceRef: tweetId, stage: 'STAGED', eventType: 'STAGE_EXIT', payload: { betType: pick.type, sport: pick.sport } });
        logTweetAudit({ ...auditBase, stage: 'saved', reason: `${pick.type}: "${(pick.description || '').slice(0, 60)}"`, bet_id: saved.id });
      } else if (saved?._deduped) {
        recordDrop({ ingestId, sourceType: 'twitter', sourceRef: tweetId, stage: 'DROPPED', dropReason: 'DUPLICATE_IMAGE', payload: { dedup: 'fingerprint', handle: cleanHandle } });
      }

      updateLastTweetId(cleanHandle, tweetId);
    } catch (err) {
      logTweetAudit({ ...auditBase, stage: 'error', reason: err.message });
      recordError({ ingestId, sourceType: 'twitter', sourceRef: tweetId, stage: 'ERROR', error: err, payload: { handle: cleanHandle } });
      console.error(`[TwitterHandler] Tweet error:`, err.message);
    }
  }

  console.log(`[TwitterHandler] Done — staged ${staged}, skipped ${skipped}, AI ${aiCalls}`);
  return { staged, skipped, aiCalls };
}

module.exports = { handleTwitterWebhookPayload, normalizeForDedup, findRecentRepost };
