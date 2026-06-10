# COA Full Multi-Repo Audit — 2026-06-10 (report only)

Report-only operational audit of all four ZoneTracker repos plus live runtime state. No production code changed, nothing deployed, nothing restarted, no DB writes. All DB access readonly (`{readonly:true}` via base64-delivered `node` scripts on Fly). Every live-state claim below carries the command + output snippet (§F appendix).

**Pinned revisions audited:**

| Repo | HEAD | Date |
|---|---|---|
| bettracker-discord-bot (main) | `84650b8` (= origin/main) | 2026-06-10 |
| zonetracker-dashboard | `409fee4` | 2026-06-07 |
| zonetracker-dubclub | `31e7166` | 2026-06-05 |
| zonetracker-scraper | `6743106` | 2026-06-07 |

**Live runtime:** Fly `bettracker-discord-bot` v591 (Jun 8 2026, machine started, image `deployment-83956c4…`); Surface Pro pm2 ×5 online, all three repo checkouts **exactly at origin/main, clean trees** (zero drift).

**Procedural notes:** (1) The prompt's seeded leads are April-era; two of three are already structurally fixed in current code — verified individually in §5. (2) `pm2 conf` echoes module config **values** — it was run once during capture, its output is excluded from this report, and it joins `pm2 jlist` on the never-run list (see H-3). (3) The prompt's "HRB pipeline PRs #52/#59/#60/#62": canonical set per `gh pr list` is **#52 Dismiss / #56 Recover / #59 backdate / #62 sweeper-grace**, with **#60 = the F-12 dedup leak-check** (not HRB).

---

## A. Severity-ranked summary

| # | Finding | Repo | Track | Sev | Fix |
|---|---|---|---|---|---|
| S-01 | 🚨 Silent zero-tweet outage: selector drift recorded as *success*, no dead-air alarm on either side | scraper | 4 | **P1** | M |
| U-1 | 🚨 Chromium death zombies the bridge: IMAP stays green, every scrape fails, no alert/exit | dubclub | 4 | **P1** | S |
| D-1 | 🚨 Upstream mid-body failure on handle-toggle **crashes the dashboard** (empirically reproduced) | dashboard | 4 | P2 | S |
| M-1 | 🚨 Escape-hatch + media exemption stage conversational image-tweets as `sport=Unknown` bets (live specimen) | discord | 4 | P2 | S |
| M-2 | 🛠️ Grader waterfall aborts on first truncated/garbage JSON instead of trying the next provider | discord | 3/4 | P2 | S |
| M-3 | 🛠️ Bing 200-with-garbage is recorded `ok`: breaker parse-blind; search layer feeds 82%-PENDING grader | discord | 4 | P2 | M |
| U-2 | 🚨 At-least-once webhook retry re-posts already-delivered picks (no progress state, 429 ignored) | dubclub | 4 | P2 | M |
| U-3 | 🛠️ "Leave unseen for retry" has no retry trigger — no periodic sweep timer | dubclub | 4 | P2 | S |
| U-4 | 🛠️ splitIntoPicks silently drops signal-less real picks and keeps odds-bearing junk | dubclub | 3 | P2 | S |
| S-02 | 🚨 `initBrowser` leaks a Chromium per 5-min cycle on partial init failure | scraper | 4 | P2 | S |
| S-03 | 🛠️ No cycle watchdog: one wedged Playwright call zombifies the daemon | scraper | 4 | P2 | S |
| M-10 | 📚 CODEMAP drift: grading.js rows +43, resolver panels gone, two live enums wrong | discord | 2 | P2 | S |
| M-11 | 📚 BACKLOG vs shipped reality: 9 stale entries incl. an open "P1 KNOWN BUG" that is fixed in code | discord | 2 | P2 | S |
| U-8 | 📚 `.env.example`/README omit `LOCKEDIN_WEBHOOK_URL` → fresh setup silently skips capper 2 | dubclub | 2 | P2 | S |
| S-04 | 🛠️ Scraper PM2: unbounded logs, no restart backoff, silent `errored` end-state | scraper | 4 | P2 | S |
| M-4 | 🛠️ `quarantined` is a terminal state with no reaper/admin surface — 11 live pending zombies | discord | 4 | P3 | M |
| M-5 | 🛠️ No retention for pipeline_events/grading_audit/search_backend_calls/dedup_events; 40M WAL > 38M DB | discord | 1 | P3 | S |
| M-7 | 🛠️ No SIGTERM/SIGINT handler anywhere; daily-restart cron exits abruptly | discord | 1 | P3 | S |
| M-8 | 🛠️ `pipeline_events.created_at` unindexed — every 24h-window query scans 67.7K rows | discord | 1 | P3 | S |
| M-9 | 🛠️ Unused dep `@google/generative-ai`; dead `purgeOldAuditLogs`; stray `/data/bets.db` | discord | 1 | P3 | S |
| M-12 | 📚 Main-repo README describes the legacy "economy" product generation | discord | 2 | P3 | M |
| M-13 | 💡 `gate3-firing-check.js` opens prod DB without `{readonly:true}` | discord | 1 | P3 | S |
| M-14 | 💡 Gate 3 still shadow (flag unset); 7 would-fires/7d must be sampled before enforce | discord | 4 | P3 | S |
| M-15 | 💡 Gates 4/5 (off-date, season-vs-game) still absent — those classes rely on prompt only | discord | 3 | P3 | L |
| M-16 | 💡 `/api/mobile-ingest` early-200 + async processing can lose a batch on restart; caption-less slips dropped | discord | 4 | P3 | M |
| S-05 | 📚 Scraper `.env.example`: 3 dead vars incl. real burner identity values; `SCRAPER_HANDLES_URL` undocumented | scraper | 2 | P3 | S |
| U-5/U-6/U-7/U-9/U-10/U-11/U-12 | 🛠️/📚/💡 dubclub: scrape over-capture doc, no ecosystem file (live-confirmed), re-download loop, wrong re-seed instructions, CODEMAP anchors, storageState never re-persisted, `npm test` unwired | dubclub | 1-4 | P3 | S |
| D-2…D-8 | 📚/💡 dashboard: auth-gate claim restated, stale "two writes" comments, log rotation, CDN pin, href scheme, troubleshooting table, path-escape test | dashboard | 1-4 | P3 | S |
| H-1/H-2/H-3 | 🛠️/💡 Host: no pm2-logrotate (16M dubclub error log), ecosystem↔runtime env drift, value-dumping pm2 commands + 2 undocumented dirs | host | 4 | P3 | S |

---

## B. Findings — bettracker-discord-bot (main repo)

### B.1 Track summaries

**Track 1 (code & resource).** `npm run check` EXIT=0; full `test:reliability` suite EXIT=0 (incl. `migration-validation.js` — see M-11c). Deps: 7 of 8 used; `@google/generative-ai` has zero require sites (M-9). God-files persist and grew since the 2026-05-22 audit (F-05): grading.js 2,673 / ai.js 1,984 / messageHandler.js 1,408 / admin.js 1,154 / database.js 1,135. Secret history clean: `git log --all --diff-filter=A` shows only `.env.example` matching secret-shaped names. Live DB: 38M + **40M WAL** at 13:11Z despite a 03:30Z VACUUM (M-5). 47 indexes live; the one hot gap is M-8.

**Track 3 (instructions).** The grader prompt (grading.js:2281-2300) is contract-tight: JSON-only, `status` enum-bound ("must be exactly one of"), `evidence_quote` REQUIRED verbatim-substring of the exact `evidenceForModel` slice Gate 3 validates against (consistency explicitly engineered, L2277-2279), "DO NOT invent scores / if unsure PENDING". `max_tokens: 1000` (L2323) with `temperature: 0` — ample for the ~80-token output (the v441 starvation class is gone; budget is 5× the old 200). The extraction prompt (ai.js:1015-1078) is similarly strong: typed responses 1-4, ANTI-PROMO, STRICT ENTITY, STAT-LINES≠LEGS, no-default-odds. Cerebras short-content silent-failure is guarded at **both** call sites: ai.js:158-159 empty content → `AdapterError.NO_CONTENT` → next provider; grading.js:2340-2347 empty `raw` → loop continues. Residual prompt-layer gaps: M-2 (truncated-JSON path), M-15 (no structural date/scope gates).

**Track 4 (resiliency).** All four search backends register 4xx/5xx and timeouts as circuit failures (`recordBackendResult`, grading.js:1521; 402/401/403 → 1h quota cooldown per config L1497-1500; ddg L1601, bing L1655/1677, brave L1703/1716, serper L1736) — requirement met, with the parse-blindness caveat (M-3). Backoff/quarantine machine: entry `applyBackoff` ladder +15m→+1h→+4h→+12h→+24h (L590-603); `attempts>=20` → `quarantined`; pickup query `grading_state IN ('ready','backoff')` (L582) never re-picks quarantined; **exit: nobody** (M-4). Denial loop capped: `scheduleRecheckAfterDenial` RETRY_CAP=15 → auto-VOID + `GRADE_BACKOFF_EXHAUSTED` (L606-641; 21 drops/7d live). Idempotency: Gate 2 `decideFinalGradeWrite` (L45) + mig 026 `grader_version`/`evidence_hash`; F-12 gate `findRecentRepost` (twitter-handler.js:72, 12h window, normal L305-315 + per-ladder-step L281-285); `dedupLeakCheck.findDedupLeaks` mirrors the gate's key exactly (imports `normalizeForDedup`), 24h lookback + 12h window, daily 13:00 UTC cron (bot.js:762) — read-only, and with daily cadence vs 36h scan span there is no coverage gap. Live: `DUPLICATE_REPOST` = 0 drops in 30d (gate only deployed Jun 8). `recoverHold` idempotent on `bets.source_message_id`; fetch-retry shipped (#65, merged into 84650b8).

### B.2 Findings

#### M-1 🚨 Escape-hatch + media exemption stage conversational image-tweets as `sport=Unknown` bets [P2, Track 4]
**Diagnostic.** Seeded lead 3 ("I'm broken." reaching the grader as sport=Unknown) is **alive for image-bearing tweets**. Chain, all current code: (1) `evaluateTweet`'s no-structure rejection is gated `if (!hasImages && preCheck === 'reject_recap')` — an attached image bypasses it (twitter-handler.js:162-168); (2) `structureDetected = hasImages || (preCheck === 'valid')` — an image **alone** counts as structure (L169); (3) when Vision says ignore and text-fallback returns null, the escape hatch force-stages `{ sport:'Unknown', type:'straight', description: text.slice(0,200) }` (L231-237); (4) `validateParsedBet(pick, text, { hasMedia: true })` passes because the slip-share exemption (Fix B `3aadc63`, ai.js `slipExempt = slipShape || hasMedia`) bypasses the entity-mismatch check; (5) STAGED → war-room noise → grader → unscoped auto-void. **Live specimen** (post-dates every bouncer fix): bet `842f75db…`, @capperledger 2026-05-13, raw_text "On the site, I've got hot/cold streaks for the cappers… *broken* down by bet type…", `source=twitter_vision`, trace `RECEIVED→AUTHORIZED→EXTRACTED→PARSED{source:"escape_hatch"}→VALIDATED{sport:"Unknown"}→STAGED`, 0 grading_audit rows, terminal `review_status=auto_void_unscoped_bet` ("Auto-voided: sport=Unknown not in supported set"). So: **no ingest-time drop exists for this class**; the text-only variant drops as `PRE_FILTER_NO_BET_CONTENT` (filter `evaluateTweet_reject_recap`), and the image variant's only guard is the grade-time auto-void. Note @capperledger is a stats/recap account in the scrape set — most of its output is this class. Impact: junk bets in war-room, `auto_void_unscoped_bet` inflation (587 all-time, the largest void bucket).
**Resolution** (exact change, twitter-handler.js:233 — require *text* structure for the escape hatch, so a bare image with conversational text drops like its text-only twin):
```js
      if (!pick) {
        // Escape hatch only when the TEXT itself shows betting structure —
        // an attached image alone is not structure (HRB-share class is
        // rescued via MANUAL_REVIEW_HOLD/Recover, not via junk staging).
        if (preCheck === 'valid') {
          console.warn(`[TwitterHandler] ESCAPE HATCH: structure detected but AI returned NULL — force-staging for review`);
          ...
        } else {
          recordDrop({ ingestId, sourceType: 'twitter', sourceRef: tweetId, stage: 'DROPPED',
            dropReason: 'PRE_FILTER_NO_BET_CONTENT',
            payload: { filter: hasImages ? 'image_no_text_structure_ai_null' : 'ai_returned_null', handle: cleanHandle } });
          continue;
        }
      }
```
Alternative if image-tweet rescue is wanted: route this branch to `MANUAL_REVIEW_HOLD` instead of staging a bet. **Fix size:** S.

#### M-2 🛠️ Grader waterfall aborts on first truncated/garbage JSON [P2, Track 3/4]
**Diagnostic.** The provider loop breaks on the first non-empty `raw` (grading.js:2341-2347); `JSON.parse` happens **after** the loop, and a parse failure `earlyReturn`s PENDING for the whole attempt (L2358-2362) instead of trying the remaining providers. This is exactly the v441 failure shape (truncated 46-char JSON → degraded PENDING) — the fix then was reverting the model; the structural hole stayed. Cost: a single provider emitting clipped/wrapped JSON wastes the attempt and a backoff slot, even with 6 healthy providers behind it.
**Resolution** (move parse inside the loop; exact refactor of L2339-2362):
```js
      const data = await res.json();
      const candidate = data.choices?.[0]?.message?.content || null;
      if (!candidate) continue; // empty content → next provider (Cerebras class)
      try {
        parsed = JSON.parse(candidate);
      } catch (e) {
        console.warn(`[AI Grader] ${provider.name} JSON parse error: ${e.message} | raw: ${candidate.slice(0, 100)} — trying next provider`);
        continue;
      }
      raw = candidate;
      winnerProvider = provider.name;
      audit.provider_used = provider.name;
      audit.raw_response = raw;
      console.log(`[AI Grader] Winner: ${provider.name} | Raw (${raw.length} chars): ${raw.slice(0, 500)}`);
      break;
```
…and delete the post-loop `JSON.parse` block (keep the `!raw` all-failed earlyReturn). **Fix size:** S.

#### M-3 🛠️ Bing 200-with-garbage records `ok`; breaker parse-blind; degraded search feeds an 82%-PENDING grader [P2, Track 4]
**Diagnostic.** `searchBing` (grading.js:1645-1681) splits on `class="b_algo"` (L1662) and records `ok` for **any** HTTP 200 (L1671-1672) — including Microsoft's drifted markup (0 hits) and generic-news homepage HTML (junk hits). The breaker therefore never opens for the broken-parse class (Bing is also deliberately un-gated, comment L1642-1644). Live evidence: 7d window `bing ok=1262`, `brave ok=84` — Brave fires only when Bing yields zero parsed hits, so ≥6.6% of searches already fall through, and junk-hit searches don't fall through at all; grading_audit is 25,465/30,896 (82%) `final_status=PENDING` all-time. Brave-402 is historical (152 all-time, 0 in 7d). This is the live successor to the resolved Brave-402 entry: the search layer, not the grader, drives the stuck-pending→mass-void symptom (BACKLOG 2026-05-19 already names it for non-MLB/NBA/NHL sports).
**Resolution** (two parts, services/grading.js):
```js
    // 1) Zero parsed hits on HTTP 200 = parse failure, not success (L1670):
    if (results.length === 0) {
      console.log(`[Search] Backend=Bing | Result=PARSE_EMPTY | Duration=${duration}ms`);
      recordBackendResult('bing', false, 'PARSE_EMPTY');
      recordBackendCall({ backend: 'bing', status: 'parse_empty', latencyMs: duration, hits: 0 });
      return [];
    }
    // 2) Generic-news detector before returning hits — if no result mentions
    //    a token from the query, treat as empty so the chain falls through:
    const qTokens = clean.toLowerCase().split(/\s+/).filter(t => t.length > 3);
    const relevant = results.some(r => qTokens.some(t => (r.title + ' ' + r.snippet).toLowerCase().includes(t)));
    if (!relevant) {
      recordBackendCall({ backend: 'bing', status: 'generic_news', latencyMs: duration, hits: results.length });
      return [];
    }
```
Watch `search_backend_calls` for a week: if `parse_empty+generic_news` exceeds ~30%, re-order the chain or add a maintained backend. (Bing stays breaker-exempt; this only stops garbage being scored healthy/fed to the model.) **Fix size:** M.

#### M-4 🛠️ `quarantined` is terminal with no reaper or admin surface [P3, Track 4]
**Diagnostic.** Entry: `applyBackoff` at `attempts >= 20` (grading.js:593-599). Exit: none — the pickup query excludes it (L582), no code ever resets it, the Stage-2 "Reaper (cron)" BACKLOG item was never built, and no `/admin` command lists or releases quarantined bets. Live cost of the absent reaper: **11 pending bets sit quarantined forever** (all `grading_attempts=20`; sample ids `52937045`, `57f50ecf`, `e76cb85e`, `19c41f5f`, `76bbffba`…), invisible except via SQL; plus 52 pending in backoff (those still retry on the 24h ladder rung until they hit 20 attempts or the no-data auto-void at 5). Total live states: done=1922, backoff=291, quarantined=18, ready=7, graded=2.
**Resolution.** Smallest useful: fold quarantined into the existing nightly purge cron as an explicit terminal void (mirrors `GRADE_BACKOFF_EXHAUSTED` semantics):
```js
        // bot.js purge cron — quarantine reaper: void anything quarantined > 7 days
        database.prepare(`UPDATE bets SET result='void', grade='VOID',
            grade_reason='Auto-voided: quarantined >7d (attempts cap reached, no evidence)',
            graded_at=CURRENT_TIMESTAMP
          WHERE grading_state='quarantined' AND result='pending'
            AND grading_last_attempt_at < datetime('now','-7 days')`).run();
```
plus a `/admin quarantined` read-only subcommand listing id/capper/description/attempts for manual rescue before the 7 days lapse. **Fix size:** M.

#### M-5 🛠️ No retention for the four biggest append-only tables; intraday WAL exceeds DB size [P3, Track 1]
**Diagnostic.** The nightly purge cron (bot.js:774-790) prunes `processed_tweets` (30d — live 2,090 rows ✓), `twitter_audit_log` (7d — 1,257 ✓), `bot_health_log` (90d — 1,618 ✓), and orphan `user_bets`; its `bets` clause targets `result='archived'`, which only the legacy `!reset_season` flow sets (bot.js:482) and which has never run (live result values: void/win/loss/pending/push only) — inert, not harmful. **Nothing prunes:** `pipeline_events` 67,749 rows (~1,070/day), `grading_audit` 30,896 (~244/day avg 14d; skip-spam fixed, see §5.1), `search_backend_calls` 6,670, `parlay_legs_dedup_events` 1,914. At current rates pipeline_events alone adds ~390K rows/year. Separately, `/data` shows `bettracker.db` 38M + `bettracker.db-wal` **40M** at 13:11Z — intraday checkpointing isn't keeping up (long-lived readers starve auto-checkpoint); the nightly VACUUM masks it daily. Also a stray zero-byte `/data/bets.db` (May 12).
**Resolution** (extend the same purge transaction; windows chosen ≥ every consumer's max lookback — admin views 24h, leak-check 36h, would-fire analysis ~30d):
```js
        database.prepare("DELETE FROM pipeline_events WHERE created_at < strftime('%s','now') - 180*86400").run();
        database.prepare("DELETE FROM grading_audit WHERE timestamp < (strftime('%s','now') - 180*86400)*1000").run();
        database.prepare("DELETE FROM search_backend_calls WHERE ts < (strftime('%s','now') - 90*86400)*1000").run();
        database.prepare("DELETE FROM parlay_legs_dedup_events WHERE created_at < strftime('%s','now') - 90*86400").run();
      })();
      database.exec('VACUUM');
      database.pragma('wal_checkpoint(TRUNCATE)');
```
(Note the unit traps: pipeline_events/dedup_events epoch-sec, grading_audit/search_backend_calls epoch-ms.) Delete `/data/bets.db` manually. **Fix size:** S.

#### M-7 🛠️ No graceful shutdown anywhere [P3, Track 1]
**Diagnostic.** `grep -rn "process\.on(" bot.js services/ handlers/ routes/ commands/` → zero hits: no SIGTERM/SIGINT handler, no `db.close()`, no cron teardown; the daily-restart cron just `process.exit(0)` (bot.js:802). Fly sends SIGTERM on every deploy/restart; better-sqlite3+WAL recovers via replay, but every restart abandons a dirty WAL (feeds M-5's 40M observation) and in-flight grading writes race the kill.
**Resolution** (bot.js, after client login):
```js
function shutdown(signal) {
  console.log(`[Shutdown] ${signal} — closing DB and exiting`);
  try { require('./services/database').db.close(); } catch (_) {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```
and replace the restart cron's `process.exit(0)` with `shutdown('daily-restart')`. **Fix size:** S.

#### M-8 🛠️ `pipeline_events.created_at` has no index [P3, Track 1]
**Diagnostic.** Live index list for pipeline_events: `idx_pipeline_events_bet, _drop_reason, _ingest, _stage_type` — no `created_at`. Every time-window consumer full-scans 67.7K rows: `/admin pipeline-drops-24h`, pipelineHealth checks, the 7d drop histograms, this audit's own queries. Growth makes it linearly worse.
**Resolution** — new migration `029_pipeline_events_created_idx.sql`:
```sql
CREATE INDEX IF NOT EXISTS idx_pipeline_events_created ON pipeline_events(created_at);
```
**Fix size:** S.

#### M-9 🛠️ Unused dependency, dead function, stray file [P3, Track 1]
**Diagnostic.** (a) `@google/generative-ai` in package.json deps — zero require/import sites repo-wide (Gemini is called via raw REST `fetch`, ai.js:169-201). (b) `purgeOldAuditLogs` (database.js:814-816, exported :1104) — never called; the purge cron inlines the identical DELETE (bot.js:782). (c) `/data/bets.db`, 0 bytes, May 12 — leftover.
**Resolution.** `npm uninstall @google/generative-ai`; delete `purgeOldAuditLogs` + its export; `fly ssh console -C 'rm /data/bets.db'` (after this report's approval — it is a deletion). **Fix size:** S.

#### M-10 📚 CODEMAP drift: +43 line shift, deleted resolver panels, two wrong live enums [P2, Track 2]
**Diagnostic.** (a) Every §services/grading.js row **below ~L1400** is +43 vs reality (the #62 sweeper block insertion was mapped for its own rows but rows beneath were not re-shifted): `buildGraderSearchQuery` 1390→**1433**, `searchBing` 1602→**1645**, `gradePropWithAI` 1736→**1779** (unverified, inferred +43), `isTrustedLossLeg` 1802→**1845** (inferred), `aggregateParlayLegResults` 1857→**1900** (inferred), `gradeParlay` 1923→**1966** (inferred), `writeGradingAudit` 1964→**2007** (verified), `gradeSingleBet` 1985→**2028** (verified), waterfall 2207-2229→**2250-2272** (verified), Gate-3 check 2324→**2374** (verified), `finalizeBetGrading` 2468→**2511** (verified). Exceeds CODEMAP's own ±20 refresh rule. (b) §commands/admin.js still maps "/admin snapshot resolver panel | 100, 541, 707-767" and "/admin resolver-health | 129, 995" — **commands/admin.js contains zero resolver references today** (grep), and `services/resolver.js` is deleted. (c) §Enums `bets.grading_state`: documented "pending / graded / locked"; **live distinct values: done(1922), backoff(291), quarantined(18), ready(7), graded(2)**. (d) §Enums `bets.source` "observed" list omits the three largest live values: twitter_vision(1134), vision_slip(571)✓, twitter_text(324), discord(88), twitter(75), untracked_win(43)✓, hold_review_script(3)✓, twitter_mobile(1), manual_hold_release(1)✓. (e) §Other tables omits `scraper_handles` (documented elsewhere in CODEMAP, but the schema list should be complete). §Schemas column lists themselves verified clean against live PRAGMA (incl. mig 028 `sweep_exempt_until`).
**Resolution** — replacement markdown (apply to docs/CODEMAP.md):
```markdown
**`bets.grading_state`** (live-verified 2026-06-10): `done`, `backoff`, `quarantined`
(attempts ≥ 20, terminal — no auto-exit), `ready`, `graded`. The mig-016 doc values
`pending`/`locked` no longer occur.

**`bets.source`** (live-verified 2026-06-10, by volume): `twitter_vision`, `vision_slip`,
`twitter_text`, `discord`, `twitter` (legacy), `untracked_win`, `hold_review_script`,
`twitter_mobile` (legacy), `manual_hold_release`.
```
…update the eleven §grading.js rows to the verified/+43 values above (re-verify the four marked "inferred" when editing); delete the two resolver rows from §commands/admin.js and annotate: "resolver panels removed; `services/resolver.js` deleted — only `resolver_events` table + fly.toml env refs remain (see audit 2026-06-10)"; add `scraper_handles` to §Other tables. **Fix size:** S.

#### M-11 📚 BACKLOG vs shipped reality — 9 stale entries [P2, Track 2]
**Diagnostic + per-entry replacement text:**
1. **"🚨 KNOWN BUG Priority 1 — Retry storm: ai_pending_legs denial bypasses attempt cap" — FIXED in code.** `scheduleRecheckAfterDenial` now has `RETRY_CAP=15` → auto-VOID + `GRADE_BACKOFF_EXHAUSTED` (grading.js:606-641); live: 21 such drops/7d. Replace the entry body with: `**RESOLVED (shipped, verified live 2026-06-10):** scheduleRecheckAfterDenial caps denial requeues at RETRY_CAP=15, then voids with GRADE_BACKOFF_EXHAUSTED inside a transaction (services/grading.js:606-641). The 162-attempt class cannot recur; GRADE_BACKOFF_EXHAUSTED firing ~3/day live.`
2. **"P2 — recordStage() does not enforce enum at write boundary" — SHIPPED as #49.** Soft warn-only validation `warnUnknownEnums` at the single write boundary (services/pipeline-events.js:110-150) + 4 drifted values registered. Mark `✅ SHIPPED (#49)`.
3. **"Pre-existing test failures on main" (3 files) — STALE.** `migration-validation.js` and `message-handler.integration.js` now pass (full `npm run test:reliability` EXIT=0 in this audit's worktree); `twitter-pipeline-validation.js` was deleted. Replace with: `✅ RESOLVED — reliability suite green as of 84650b8 (verified 2026-06-10); twitter-pipeline-validation.js removed.`
4. **Foundation items shipped long ago, still listed as TODO:** "Grading audit table" (live: 30,896 rows + `/admin` trail), "State snapshot admin command" (`/admin snapshot`), "CI reliability gate" (.github/workflows/ci.yml runs check + test:reliability — and the suite is green so the gate is now meaningful), "Deploy verification protocol" (DEPLOY_CHECKLIST.md). Move all four under a `✅ Shipped` header.
5. **"Surface Pro → Scraper (building now)" — STALE:** scraper is v2.0 in production (zonetracker-scraper @6743106, pm2 online 13h). Replace with a pointer to that repo.
6. **Odds API 401 entries (two: "Odds API: 401 Unauthorized…" and "Odds API key 401 Unauthorized") — RESOLVED by the June-1 quota reset.** Live status-only round-trip from the Fly container 2026-06-10: **HTTP 200** on `/v4/sports` with the primary key. Replace both with: `✅ RESOLVED 2026-06-10 — free-tier quota reset June 1 restored auth (HTTP 200 verified from the container). The caching design (odds_snapshots) remains the pre-July to-do if usage repeats the burn rate.`
7. **"Cerebras llama3.1-8b retires 2026-05-27" + "Wire Cerebras grader model to env var" — STALE line refs.** The grader waterfall now leads `groq-llama4-scout` and pins Cerebras to `gpt-oss-120b` hardcoded at grading.js:2254 (not 1995, not qwen). The retire deadline passed without incident. Rewrite the wire-to-env-var item to cite `services/grading.js:2254` and note ai.js:44's `CEREBRAS_MODEL` default already exists.
8. **F-12 leak-check "deployed v576"** (✅-SHIPPED section): premature when written (v576 predates the #60 merge); now moot — live image v591 (built Jun 8 from main incl. 7fa1bfb). Correct to "deployed with the Jun 8 v589-v591 deploys".
9. **Brave-402 family:** already correctly marked resolved — no change; the *live* search problem is M-3 (Bing parse) and should be cross-linked from the "Bing scraper returns generic news" entry: add `Audit 2026-06-10: still live — 84 Brave fallbacks/7d, breaker parse-blind; see M-3 resolution.`
**Fix size:** S (pure doc edit).

#### M-12 📚 README.md describes the legacy product [P3, Track 2]
**Diagnostic.** README (63 lines) documents a virtual-economy bot: tail/fade bankrolls, `!bankroll`/`!mystats`/`!leaderboard`/`!status`/`!reset_season` prefix commands, "Gemini 2.0 searches the web every 15 minutes", `#submit-picks` delete-and-stage flow, "Future Roadmap: X/Twitter tracking" (shipped a year of versions ago). Nothing about: slash commands, the grading gate stack, pipeline_events, the admin HTTP API, the Surface Pro satellites, fly deploy invariants. A new operator following it would be lost; CODEMAP/PREFLIGHT carry the real knowledge but README is the front door.
**Resolution** — replace body with a thin, link-out README (keep it short so it can't rot):
```markdown
# ZoneTracker — bettracker-discord-bot
AI pipeline that ingests sports-bet slips from Discord channels and Twitter/X,
stages them for human review, and autonomously grades results.
Runs on Fly.io (app `bettracker-discord-bot`, SQLite on a /data volume).

## Operator docs (authoritative)
- docs/CODEMAP.md — file/line map, schemas, channels, env vars. Read first.
- docs/PREFLIGHT.md — session-start checklist (DB quirks, fly ssh patterns).
- docs/DEPLOY_CHECKLIST.md — every deploy is MANUAL: `fly deploy --local-only --yes --no-cache`.
- docs/BACKLOG.md — roadmap + known issues. docs/audits/ — point-in-time audits.

## Satellites (separate repos, Surface Pro / PM2)
zonetracker-scraper (X timelines → /api/mobile-ingest) · zonetracker-dubclub
(Gmail→Playwright→webhooks) · zonetracker-dashboard (operator UI → admin API) ·
zonetracker-ocr (RapidOCR microservice).

## Dev
npm install && npm run check && npm run test:reliability
```
**Fix size:** M (mostly deletion).

#### M-13 💡 `gate3-firing-check.js` opens the prod DB read-write [P3, Track 1]
**Diagnostic.** SELECT-only script, but `new Database(process.env.DB_PATH || '/data/bettracker.db')` (scripts/gate3-firing-check.js:16) takes a write handle — needless lock/WAL interaction for a diagnostic, and violates the repo's own read-only-diagnostics convention.
**Resolution.** `const db = new Database(process.env.DB_PATH || '/data/bettracker.db', { readonly: true });` **Fix size:** S.

#### M-14 💡 Gate 3 enforce-flip blocked on 7 unsampled would-fires [P3, Track 4]
**Diagnostic.** `QUOTE_BOUND_GRADING` is **unset** in the container → `resolveGate3Mode` → shadow (default). 7-day live read (`WIN_H=168 node scripts/gate3-firing-check.js`): non-PENDING 145; Gate-3-evaluated 46 (LLM-graded; espn=105 + mlb_statsapi=10 bypass via adapters); **passed 45 / would-fire 7**. The script's own flip rule ("evaluated ≥ ~20-30 with would-fire 0") is volume-satisfied but **blocked on the 7 would-fires** until they're classified hallucination vs correct-but-unquotable.
**Resolution.** Run the sampling query, eyeball `raw_response` vs `final_evidence` per row, then either fix quote-normalization gaps or flip:
```sql
SELECT bet_id, leg_index, provider_used, substr(raw_response,1,200) raw, substr(final_evidence,1,200) ev
FROM grading_audit WHERE guards_failed LIKE '%GATE3_WOULD_FIRE%'
ORDER BY timestamp DESC;
```
Flip = `fly secrets set QUOTE_BOUND_GRADING=enforce` + deploy + verify per BACKLOG's staged≠live rule. **Fix size:** S.

#### M-15 💡 Gates 4/5 absent — off-date and season-vs-game classes rely on the prompt alone [P3, Track 3]
**Diagnostic.** Seeded lead 2's four April failure classes, mapped to current structural guards: **WIN-with-PENDING-legs** → Gate 1 `reduceParlayResult` LOSS>PENDING>WIN + INVARIANT guard (grading.js:209, :233-234) ✅; **wrong-entity evidence** → G6 `player_not_in_evidence` (v357) + Gate 3 quote-binding (shadow) ✅; **rambling non-contract output** → JSON-only contract + `response_format: json_object` + parse-fail→PENDING ✅ (M-2 improves it); **grading from season stats instead of the target game** → **NO structural guard** — only the prompt line "Grade this bet ONLY using the search results below… If no final score found for this game on ${betDate}, return PENDING" (L2282, L2299). Same for wrong-date evidence. BACKLOG already specs Gates 4/5 with the right shape (dated+scope-tagged evidence layer, shadow-first).
**Resolution.** No new design needed — schedule the existing BACKLOG "Grading gates 4–5" item; precondition is the evidence-record layer it names. Until then the class is mitigated but not closed by Gate 3 enforce (a season-stat quote is still a verbatim quote). **Fix size:** L.

#### M-16 💡 `/api/mobile-ingest` early-200 can lose a batch; caption-less slip tweets always dropped [P3, Track 4 — cross-repo, surfaced by scraper audit]
**Diagnostic.** (a) routes/api.js:49-50 ACKs 200 before processing and processes async; the scraper advances its cursor on that 200, so a Fly restart mid-batch (≥3s/tweet windows) loses the batch permanently — at-least-once delivery downgraded to at-most-once. (b) twitter-handler.js:117-120 drops `!text` tweets as `PRE_FILTER_NO_BET_CONTENT` **before** looking at `imageUrls` — a capper posting a bare slip screenshot with no caption is always lost, and this is the amplifier that makes scraper S-01 silent (a `tweetText`-selector drift ships `text:''` for everything).
**Resolution.** (a) persist-then-ack: synchronous `INSERT` of the raw batch into a small `ingest_queue` table before the 200, drain in the existing async path, delete on completion. (b) one-liner: `if (!tweetId || (!text && imageUrls.length === 0)) {` — the vision path already handles image-with-empty-text. **Fix size:** M (a) + S (b).

---

## C. Findings — satellite repos

### C.1 zonetracker-dashboard (@409fee4) — tests 35/35 green, secret history clean

#### D-1 🚨 Upstream mid-body failure on the handle-toggle write crashes the whole process [P2, Track 4]
**Diagnostic** (empirically reproduced against the real server.js with a stub upstream that destroys the socket mid-body). `relayUpstream` guards `fetch()` but not the body read — server.js:109 `const body = await upstreamRes.text();` sits outside the try/catch (:94-105). GET/dismiss/recover return the promise to Express 5 → HTML 500 instead of the documented 502 JSON; the handle-toggle path runs inside the `jsonParser(req,res,(err)=>{…})` callback (:157) so the rejection is **unhandled → process exit** (`TypeError: terminated`, child exited code 1 in repro). One flaky upstream response during a toggle kills the dashboard for all operators; `max_restarts: 10` means a persistently sick upstream parks it errored.
**Resolution** (make `relayUpstream` total):
```js
  let body;
  try {
    body = await upstreamRes.text();
  } catch (err) {
    const reason = err && err.name === 'TimeoutError' ? 'Upstream timed out.' : 'Upstream response truncated.';
    console.error(`[proxy] ${method} ${req.originalUrl} -> BODY ERROR (${err && err.name})`);
    return res.status(502).json({ error: 'Bad Gateway', detail: reason });
  }
```
plus the mid-body regression test (stub route that `writeHead`s then `socket.destroy()`s; assert 502 JSON on both GET and POST paths). **Fix size:** S.

#### D-2 📚 "auth-gate-before-express" claim: no such file/test exists; the dashboard has no auth middleware [P3, Track 4]
**Diagnostic.** Exhaustive search (all history, both repos): nothing named like `auth-gate-before-express`; the dashboard has **no auth layer at all** — protection is `HOST='127.0.0.1'` binding (server.js:29) behind `tailscale serve`. What IS true: the `/api/admin` proxy (server.js:121) mounts before `express.static` (:180) — a routing-precedence property — and bearer auth is enforced **bot-side** (`routes/admin.js:39` router-wide; adminCommands.js:76/119/180 per-route). The prior claim as phrased gives false assurance about where authentication lives.
**Resolution.** Record the invariant accurately (dashboard = loopback bind + tailnet, proxy-before-static; bearer = bot-side only) + the optional mount-order pinning test (`app.router.stack` order assert, verified to work on express 5.2.1). **Fix size:** S.

#### D-3…D-8 (condensed; full patches in the dashboard agent transcript, reproduced essentials here)
- **D-3 📚 P3** stale "read-only / two writes" comments contradict the shipped three writes (app.js:2-3, :302, :413; test/proxy.test.js:3-4; index.html:18 visible UI label). Patch: update each to "THREE narrow writes: hold dismiss, hold recover, handle enable/disable"; index.html → `Admin dashboard (read-mostly)`.
- **D-4 💡 P3** one log line per proxied request × 30s polling ≈ 11.5K lines/day, no rotation → `pm2 install pm2-logrotate; pm2 set pm2-logrotate:max_size 10M; pm2 set pm2-logrotate:retain 14; pm2 set pm2-logrotate:compress true` (covers H-1 too) and/or gate server.js:110 on `status >= 400`.
- **D-5 💡 P3** Pico CSS from jsdelivr `@2` floating tag, no SRI, offline = unstyled → vendor `public/pico.min.css`, link locally.
- **D-6 💡 P3** `discordUrl` renders upstream-supplied strings as `href` verbatim (app.js:89-97 → :107) → add `safeHttpUrl()` (URL-parse, allow http/https only).
- **D-7 📚 P3** README lacks a troubleshooting table mapping 502-local / 401/403-bearer / 503-fail-closed / unstyled / FATAL-at-boot to fixes → table supplied in agent report; append to README.
- **D-8 💡 P3** the path-escape guard (server.js:131-133) has no test (fetch normalizes dot-segments client-side; needs a raw-socket test) → add the `%2e%2e` raw-socket 400 test.

**Looked good:** fail-closed startup; method/path gate before body parsing; write-body whitelisting; status-string contract matches the bot exactly (no drift, incl. all dismiss/recover/handle enums); zero-XSS rendering (text nodes only); env-var docs in perfect sync; no dead code; bounded state; loopback bind.

### C.2 zonetracker-dubclub (@31e7166) — split tests 8/8 pass (direct), secret history clean (no storageState/.env ever committed)

**Track 3 determination:** no LLM anywhere in the repo; `splitIntoPicks` is deterministic regex (split-picks.js:5-29) — audited as split heuristics (U-4/U-5).

#### U-1 🚨 Browser death zombies the process — no `disconnected` handler, no alert, no exit [P1, Track 4]
**Diagnostic.** Chromium launches once per process lifetime (index.js:301) and is never health-checked. If it dies (OOM on the Surface Pro — plausible over weeks-long uptimes), every later email fails at `ctx.context.newPage()` (index.js:192), swallowed by the per-email catch (:260-261): no admin alert (unlike login-wall :197 and empty-scrape :206), no exit. IMAP stays healthy, PM2 sees green, 100% of scrapes fail until a human restarts. Contrast: IMAP death is correctly crash-only (`close` → `cleanup(1)` → exit, :359-362 — live-verified working: 11 "IMAP connection closed. Exiting so PM2 can restart." exits Jun 9-10, pm2 ↺4); the browser half has no equivalent.
**Resolution** (after `cleanup` is defined, index.js:327):
```js
  browser.on('disconnected', () => {
    if (shuttingDown) return; // expected during cleanup()
    errlog('Playwright browser disconnected unexpectedly. Exiting so PM2 can restart.');
    alertAdmin(':warning: DubClub bridge: Chromium died — restarting via PM2.')
      .finally(() => cleanup(1));
  });
```
**Fix size:** S.

#### U-2 🚨 At-least-once webhook retry double-posts; downstream has no text dedup on this path [P2, Track 4]
**Diagnostic.** Only idempotency state is `\Seen`, set after success (index.js:256). (1) Split path: on any non-2xx/throw mid-loop (429 `retry_after` ignored — index.js:220; 6 picks at 400ms spacing is a 429-shaped burst) the email stays unseen and the next sweep re-posts **from pick 0**. (2) If the post succeeds but `messageFlagsAdd` throws, the whole sheet re-posts. Verified downstream (main repo): text-content dedup exists only on the **twitter** path (`findRecentRepost`, twitter-handler.js:72); the Discord-webhook ingest these posts take has only image-fingerprint dedup, and split-channel posts bypass straight into `processAggregatedMessage` (messageHandler.js DUBCLUB SPLIT BYPASS). The war-room human gate is the only stop (hence P2 not P1).
**Resolution.** Persist per-email post progress keyed `UIDVALIDITY:UID` (resume from index k, delete on success), honor 429 `retry_after`, and `alertAdmin` on flag-add failure ("manual mark needed to avoid duplicate"). Full patch in the agent transcript (`post-progress.json` + `postWebhookWithRetry`); prune entries >7d on load. **Fix size:** M.

#### U-3 🛠️ "Leave unseen for retry" has no retry trigger [P2, Track 4]
**Diagnostic.** Sweeps run exactly twice: startup (index.js:364-365) and on IMAP `exists` (new mail, :350-353). No `setInterval` exists. Every "leaving unseen for retry" path (webhook 5xx :250, scrape-empty :205, no-URL :184, login wall :196) actually waits for the **next unrelated email** or a manual restart — docs/BRIDGE.md:27 admits it; README:87 oversells. A transient Discord 5xx on the night's last email = picks delayed till morning.
**Resolution.** `const sweepTimer = setInterval(safeSweep, 10*60*1000);` after the initial sweep + `clearInterval(sweepTimer)` in `cleanup()` — the existing `sweeping`/`pendingSweep` mutex (:332-348) already makes overlap safe. **Fix size:** S.

#### U-4 🛠️ splitIntoPicks silently loses signal-less picks, keeps odds-bearing junk [P2, Track 3]
**Diagnostic** (probed against the actual code): `'Thunder to win the NBA title 3u'` → dropped; `'LeBron James 25.5 points 2u'` → dropped; parlay header `'3 leg parlay +450'` → kept as a phantom pick; `'Yesterday: 4-1 +320 units'` and `'Use code DUB for +200 boost'` → kept. The dangerous half is silent **partial** loss: when `picks.length > 0` only kept lines post and the email is `\Seen`-ed (index.js:212-236) — a dropped real pick vanishes with zero log; the fallback+alert fires only when ALL lines drop (:238-240). Latent until a capper's format drifts.
**Resolution.** Measurement-first telemetry at the call site (log `pick-like` lines the splitter dropped — patch in agent transcript), escalate to `alertAdmin` after observing false-positive rate; optionally drop odds-bearing lines matching `\b(units?|record|yesterday|last (week|night))\b/i`. **Fix size:** S.

#### U-5…U-12 (condensed)
- **U-5 🛠️ P3** `scrapePicks` takes the **longest** `innerText` of selector candidates incl. `main` (index.js:99-120) — feed bleed already observed ("Show More Posts" in the chrome filter); BACKLOG's "cosmetic only" claim is wrong for any neighboring post's odds-bearing line. Patch BACKLOG.md:17 (text supplied in agent transcript); scraper fix bundles with capper-#2 work (first-element-of-first-selector).
- **U-6 🛠️ P3** no ecosystem config — **live-confirmed**: dubclub is the only Surface Pro app without `ecosystem.config.js`; repo history records a 325-restart crash-loop. Commit `ecosystem.config.cjs` with `exp_backoff_restart_delay: 5000`, `max_memory_restart: '400M'`, README: `pm2 start ecosystem.config.cjs && pm2 save && pm2 install pm2-logrotate`.
- **U-7 🛠️ P3** permanently-skipped unseen emails re-download **full bodies** every sweep (`fetchOne(uid,{source:true})` before any filtering, index.js:152) and login-wall re-alerts spam per sweep during expiry → envelope-first fetch + process-lifetime `skippedUids` Set + 1h alert cooldown (patch in transcript).
- **U-8 📚 P2** `.env.example` (:10-12) and README (:51-58) omit `LOCKEDIN_WEBHOOK_URL` (config.json names it; code resolves dynamically index.js:176) — fresh setup silently skips LockedIn with a per-email "env var not set. Leaving unseen." Add the line to both; also README repo-layout is missing split-picks.js/tests/docs and the config shape omits `splitIndependent`.
- **U-9 📚 P3** the session-expiry **alert text itself** (index.js:198) and README say `npm run seed` on the box — SESSION-LOG records that path doesn't work (headless; the working procedure is seed-mac.js on the Mac + scp). Fix alert text + README; commit `seed-mac.js` (currently untracked on the Mac only) and `dump-dom.cjs` or note them untracked.
- **U-10 📚 P3** CODEMAP anchors drifted +3 (`requireEnv` L23→26, `extractPlaysUrl` L54→57).
- **U-11 💡 P3** storageState.json read once, never re-persisted (`context.storageState()` never called) — cookie refreshes die on restart, forcing earlier re-seeds; malformed file crash-loops. Persist after each successful scrape + JSON-validate in `ensureSeedExists`.
- **U-12 💡 P3** `npm test` missing (tests pass via direct `node tests/split-picks.test.js`) — add the script.

**Looked good:** IMAP IDLE lifecycle is sound crash-only design (imapflow's 5-min NOOP probe preempts Gmail's ~29-min IDLE kill; every failure funnels to exit→PM2); per-email pages closed in `finally`; goto/innerText timeouts everywhere; `\Seen`-after-2xx is the right direction; webhook-token leaks during setup went to chat only, both rotated, **never into git**; all 4 deps used; docs unusually good for a side service.

### C.3 zonetracker-scraper (@6743106) — no tests exist (`node --check` clean), secret history: no cookie/session/db file ever committed

#### S-01 🚨 Silent zero-tweet outage: selector drift is rewarded as success, and nobody alarms [P1, Track 4]
**Diagnostic.** The strike/disable system fires only on *thrown* errors. Every empty-but-non-throwing drift mode is recorded as a successful poll that **resets strikes** (scraper.js:224-228: `0 tweets` → `strikes = 0`). If `a[href*="/status/"]` (scraper.js:135) stops matching, every article maps `id:null`, all filtered (:166) → "0 tweets" forever, silently. Hard failures (container selector gone, cookie expiry → login wall) only produce per-handle TimeoutErrors → 5 strikes → 6h disable loop, console-only. `fetchTweets` (:110-171) has **no login-wall / rate-limit / captcha detection**; `runCycle` (:300-322) computes no aggregate; and the main bot has **no scraper-silence watchdog either** (healthReport.js: zero scraper mentions). Expired `browser_cookies.json` is the *expected* eventual failure, and its discovery mechanism today is a human noticing tweets stopped.
**Resolution** (two parts; full code in agent transcript): (1) in `fetchTweets`, `articles rendered but zero ids` → **throw** (`selector drift`) so it strikes instead of resetting; (2) cycle-level dead-air alarm: count fetched-total per cycle, 3 consecutive all-zero cycles with active handles → Discord-webhook `🚨` alarm (`ALERT_WEBHOOK_URL`, alarming on *fetched*=0 not *new*=0 to avoid quiet-timeline false positives). Bot-side complement: a "no mobile-ingest for N hours" check in healthReport (pairs with M-16b). **Fix size:** M.

#### S-02 🚨 `initBrowser` leaks a Chromium per cycle on partial init failure [P2, Track 4/1]
**Diagnostic.** scraper.js:86-100 — `chromium.launch()` succeeds, then `JSON.parse(browser_cookies.json)` / `addCookies` throws → catch returns `false` **without closing the browser**; next cycle's launch overwrites the module-level var, orphaning ~100-200MB of headless Chromium **every 5 minutes** until the box exhausts memory. A slightly-off Cookie-Editor export triggers it persistently. PM2's `max_memory_restart: '500M'` watches only the node process, not Chromium children.
**Resolution.** In the catch: `await shutdownBrowser();` before `return false` (`shutdownBrowser`, :103-107, is already idempotent). **Fix size:** S.

#### S-03 🛠️ No cycle watchdog: one wedged Playwright call zombifies the daemon [P2, Track 4]
**Diagnostic.** `page.$$eval`/`page.evaluate` (:123, :127, :132) take no timeout; a hung renderer blocks forever, `cycleInProgress` never resets (:321), every future tick exits at :301 "Previous still running". Process looks healthy to PM2 — permanent zombie, manual-restart-only.
**Resolution.** `runCycleWithDeadline()` wrapper: 10-min `setTimeout` → `process.exit(1)` (cursor + seen state live in SQLite; restart is lossless), `unref()`d, `clearTimeout` in `finally`; schedule it at :338/:340. **Fix size:** S.

#### S-04 🛠️ PM2 config: unbounded logs, no backoff, silent `errored` end-state [P2, Track 4/1]
**Diagnostic.** `error_file`/`out_file` flat files (ecosystem.config.js:12-13), 10+ lines per 5-min cycle, no rotation anywhere (live: scraper-out.log already 15M, see H-1); `max_restarts: 10` + `min_uptime: 60s` with **no** `exp_backoff_restart_delay` → a boot-loop fault (corrupt scraper.db at module load :44-55; missing secret exit :42) burns 10 instant restarts and parks the app `errored`, permanently down, no alert.
**Resolution.** Add `exp_backoff_restart_delay: 1000`, `log_date_format`, `merge_logs` to ecosystem.config.js (full block in transcript) + one-time `pm2 install pm2-logrotate` host setup (shared with D-4/H-1). **Fix size:** S.

#### S-05 📚 `.env.example` carries dead vars including real burner identity values [P3, Track 2]
**Diagnostic.** Code at HEAD reads exactly 4 env vars (`INGEST_URL` :22, `MOBILE_SCRAPER_SECRET` :23, `SCRAPER_HANDLES_URL` :24, `BACKFILL` :40). `.env.example:5-8` documents a `TWITTER_USERNAME/PASSWORD/EMAIL` block nothing reads (v1.x credential-login leftover) — and the username/email lines hold **real values, not placeholders** (values withheld here; password/secret lines are placeholders). Meanwhile `SCRAPER_HANDLES_URL` — honored by code — appears in neither `.env.example` nor README.
**Resolution.** Replacement `.env.example` (in transcript): the 3 live vars + comment that v2.0 auth is `browser_cookies.json`, drop the TWITTER_* block. History rewrite optional (values already public-ish in history); stop advertising them at HEAD. **Fix size:** S.

#### S-08 🛠️ Boot banner reports the dead fallback list as "Handles" [P3, Track 1/2]
**Diagnostic.** scraper.js:332 prints the 9-entry built-in fallback array length; the live set is DB-driven per cycle (12-13 enabled). Misleading exactly when someone is reading boot logs during an incident.
**Resolution.** `console.log(\`  Handles: DB-driven via /api/scraper-handles (built-in fallback: ${HANDLES.length}) | Schedule: ${CRON_SCHEDULE}\`);` **Fix size:** S.

(S-06 and S-07 are bot-side and filed as M-16.)

**Looked good:** README "Polling & cursor behavior" verified accurate claim-by-claim (cron `*/5`, BACKFILL one-shot, 4s gap, overlap guard, count formula, scroll caps, two-layer dedup, cursor-advance-on-success-only, 30d seen-tweets prune, honest downtime semantics); cross-repo payload/auth contract verified end-to-end; per-handle try/catch isolation; ambiguous-outcome retries safely absorbed by bot id-dedup; fail-fast on missing secret; SIGTERM/SIGINT close browser+db.

---

## D. Host (Surface Pro) findings

#### H-1 🛠️ No pm2-logrotate; dubclub error log already 16M [P3, Track 4]
**Diagnostic.** `~/.pm2/modules` contains no logrotate module; `~/.pm2/logs` totals 41M: dubclub-error 16M (dominated by the IMAP exit/EAI_AGAIN cycle — 11 exits Jun 9-10), scraper-out 15M, dubclub-out 11M. Disk is fine today (17% used, 184G free) but growth is unbounded and the error log's size makes incident greps slow.
**Resolution.** One-time: `pm2 install pm2-logrotate && pm2 set pm2-logrotate:max_size 10M && pm2 set pm2-logrotate:retain 14 && pm2 set pm2-logrotate:compress true` (also closes D-4/S-04/U-6's log halves). **Fix size:** S.

#### H-2 💡 Ecosystem↔runtime env drift (the triple-location class) [P3, Track 4]
**Diagnostic** (key names only). dashboard: ecosystem declares `NODE_ENV` and the running proc has it ✓. **scraper: ecosystem declares `NODE_ENV` but the running process env lacks it** — started outside the ecosystem file (or before that line landed); harmless today (nothing reads it) but it proves the process isn't running from the committed config. **dubclub: no ecosystem file at all** (U-6) — its restart policy lives only in the PM2 dump. App secrets are dotenv-loaded inside each process (correctly NOT in PM2's env table). ocr runs from `.venv/bin/python` under pm2.
**Resolution.** When applying U-6/S-04: `pm2 delete <app> && pm2 start ecosystem.config.js && pm2 save` per app so dump, file, and runtime converge (DEPLOY_CHECKLIST Step 9's three-location rule, applied to all apps not just ollama-proxy). **Fix size:** S.

#### H-3 💡 Ops hygiene notes [P3]
(a) `pm2 conf` dumps module config **values** (observed during this audit's capture; output excluded from this report) — add it to the never-run list beside `pm2 jlist` in any runbook that mentions them; consider rotating `OLLAMA_PROXY_SECRET` at next convenience since it transited a terminal. (b) Two undocumented dirs on the box: `~/zonetracker-stats` (23M, not in pm2 list — unknown status) and `~/zonetracker` (97M node_modules — appears to be a dead old checkout); inventory or remove. (c) dubclub `config.json.bak` sits beside config.json (drift trap; gitignored, but delete once confirmed stale).

---

## E. Known-items verification (one line each, live evidence)

| Item | Verdict | Evidence (2026-06-10) |
|---|---|---|
| Bing scraper b_algo parse | **Still broken-by-drift, mitigated by fallback; breaker parse-blind** | Code now at grading.js:1645-1681 (split on `class="b_algo"` L1662; prompt's ~1369-1404 and CODEMAP's 1602 both stale); live 7d: bing ok=1262, brave fallback ok=84, bing 5xx=1 → M-3 |
| Odds API auth failures | **RESOLVED (stale known-item)** | Status-only round-trip from the container: `HTTP 200` on `/v4/sports` with `ODDS_API_KEY` (key never printed); June-1 quota reset per BACKLOG prediction → M-11.6 |
| Backoff/quarantine counts vs expected 55/11 | **52/11 (pending)** — matches within drift | `SELECT grading_state, COUNT(*) FROM bets WHERE result='pending' GROUP BY 1` → backoff 52, quarantined 11, ready 7; all-state: done 1922 / backoff 291 / quarantined 18 / ready 7 / graded 2 |
| Gate 3 evaluated-grade count (scripts/gate3-firing-check.js — read first: SELECT-only, but opens DB rw → M-13) | **46 evaluated / 45 passed / 7 would-fire** (7d, distinct bet+leg) | `WIN_H=168 node scripts/gate3-firing-check.js` on Fly; non-PENDING 145 (espn 105 + statsapi 10 bypass); cross-check: `guards_failed LIKE '%GATE3_WOULD_FIRE%'` → 11 markers / 7 bets all-time |
| Resolver app + fly.toml refs | **App suspended; env refs remain; code already deleted** | `fly apps list` → `zonetracker-resolver  suspended`; fly.toml:10-11 `RESOLVER_URL`/`RESOLVER_VERSION = 'v10'`; `services/resolver.js` gone; commands/admin.js zero resolver refs (CODEMAP stale → M-10); `resolver_events` 481 rows orphaned |
| Local worktree count | **5** (incl. this audit's own) | `git worktree list`: main@84650b8, 2b2-fetch-retry@1969a68 (**stale — #65 merged**), beautiful-heyrovsky@84650b8, coa-full-audit@84650b8, dreamy-hugle@84650b8 |
| Migration 028 sweep_exempt_until | **Present + live + in use** | File at migrations/028; live `PRAGMA table_info(bets)` includes `sweep_exempt_until:TEXT`; 34 rows currently stamped |
| Mode flags | QUOTE_BOUND_GRADING **unset** (→ shadow default), GEMMA_FALLBACK_DISABLED **true**, AUTOGRADER_DISABLED **false**, TWITTER_POLLER_DISABLED **true** | `fly ssh console` echo of exactly these four (§F.6) |

## §5. Seeded leads (April-era) — verdicts

**5.1 grading_audit write on every skip-too-recent attempt → FIXED; residual growth quantified.** Current code suppresses exactly this: the TOO_RECENT gate passes `{ dropReason: 'GRADE_TOO_RECENT', suppressAudit: true }` (grading.js:2151) and `earlyReturn` honors it — "the TOO_RECENT time gate fires every 10s per pending bet. Skip writeAudit when callers flag suppressAudit" (L2114-2118). Live confirmation: max per-bet audit rows in 24h = **2** (vs the April storms: bet `5896733c…` 294 rows/leg × 5 legs, 2026-04-11→14; `1beeceb1…` 204 rows, both pre-fix relics). Residual: ~244 rows/day average (14d), 30,896 total, `final_status` 82% PENDING — legitimate state-change attempts; growth is slow but unbounded → retention in M-5. SKIP paths writing nothing is correct as designed.

**5.2 Pre-gate grader failure classes → structural guard map.** WIN-with-PENDING-legs → **Gate 1** `reduceParlayResult` (LOSS>PENDING>WIN, invariant forces PENDING; grading.js:209/:233) + `aggregateParlayLegResults` untrusted-LOSS downgrade. Wrong-entity evidence → **G6** player-not-in-evidence (v357) + **Gate 3** quote-binding (shadow; enforce pending M-14). Rambling non-contract output → prompt JSON contract + `response_format: json_object` + parse-fail→PENDING (improved by M-2). Season-stats-instead-of-game and wrong-date → **gap**: prompt-only today; Gates 4/5 specced in BACKLOG, not built → M-15.

**5.3 "I'm broken." as sport=Unknown →** root path identified and **still open for image-bearing tweets**: twitter-handler escape hatch (L231-237) + `hasImages`-bypassed structure check (L162-169) + `hasMedia` validator exemption; live specimen `842f75db…` (2026-05-13, @capperledger). Text-only variant is dropped today as `PRE_FILTER_NO_BET_CONTENT` (`evaluateTweet_reject_recap`); the image variant's only terminal guard is the grade-time `auto_void_unscoped_bet`. Fix = M-1.

## §Track-2 extras verified

- **DEPLOY_CHECKLIST.md:** `--no-cache` present (Step 5 command + dedicated "--no-cache discipline" section) **and** Step 4a branch/clean pre-build gate present (L104-115) — both required items already landed (#64); no patch needed.
- **HRB pipeline narrative:** BACKLOG's ✅-Shipped Phase 2b-2 section + P1 cross-ref are accurate (P2a root-cause `ai_is_bet_false` correctly still open); canonical PR set #52/#56/#59/#62 (+#65 fetch-retry, merged post-entry — add to the shipped list when next touched).
- **DubClub bridge:** correctly listed as ✅ Shipped; no "listed as future" instance found in BACKLOG at HEAD.
- **README coverage per repo:** discord = legacy-product rewrite needed (M-12); dashboard = excellent minus troubleshooting (D-7); dubclub = good minus env/layout staleness (U-8/U-9); scraper = accurate on behavior, stale on env (S-05).

---

## F. Appendix — live-state commands + output snippets

**F.1 Fly releases/status/apps**
```
$ fly releases -a bettracker-discord-bot | head -6
 v591  complete  Release  r88510179@gmail.com  Jun 8 2026 20:59
 v590  complete  Release  …  Jun 8 2026 20:13
$ fly status -a bettracker-discord-bot
 Machines: app d897960c2e4158  VERSION 591  iad  started  2026-06-10T08:02:08Z
$ fly apps list
 bettracker-discord-bot  personal  deployed   Jun 8 2026 20:59
 zonetracker-resolver    personal  suspended
$ grep -n -i resolver fly.toml
 10:  RESOLVER_URL = 'http://zonetracker-resolver.internal:8080'
 11:  RESOLVER_VERSION = 'v10'
```

**F.2 Schema dump** (readonly base64 node script `/tmp/coa-schema.js`; full PRAGMA per table captured): 27 tables; `bets` columns match CODEMAP §Schemas including `sweep_exempt_until:TEXT`; 47 indexes — pipeline_events has bet/drop_reason/ingest/stage_type, **no created_at**.

**F.3 Counts** (readonly script `/tmp/coa-counts.js`):
```
bets by grading_state: done 1922 | backoff 291 | quarantined 18 | ready 7 | graded 2
bets by result: void 1200 | win 504 | loss 464 | pending 70 | push 2
pending by state: backoff 52 | quarantined 11 | ready 7
grading_audit: total 30896; rows/day 14d: 101,228,281,297,383,282,284,239,199,156,87,101,491,169,118
  top10 per-bet: 5896733c-leg1..5 = 294×4+292 | 1beeceb1 = 204 | 6f4ff5b1-leg1..4 = 186×4
  final_status alltime: PENDING 25465 | WIN 3470 | LOSS 1795 | VOID 149 | PUSH 10 | null 6 | " PENDING" 1
  top per-bet 24h: max 2 rows
gate3 would-fire markers: 11 rows / 7 distinct bets
rowcounts: pipeline_events 67749 | grading_audit 30896 | search_backend_calls 6670 |
  parlay_legs 2565 | bets 2240 | processed_tweets 2090 | parlay_legs_dedup_events 1914 |
  bot_health_log 1618 | twitter_audit_log 1257 | resolver_events 481 | daily_snapshots 394 |
  hold_review_decisions 161 | vision_failures 63 | user_bets 24 | cappers 28 | bet_grade_history 0 | regrade_results 0
pipeline_events rows/day 7d: 766,1472,840,1170,993,1632,1189,509
sweep_exempt_until set: 34
```

**F.4 Search backend health** (`search_backend_calls.ts` is epoch **millis** — sample 1781095602270):
```
7d (ms-window): bing ok 1262 | brave ok 84 | bing http_5xx(500) 1
alltime: bing ok 6374 | brave http_402 152 | brave ok 102 | brave circuit_open 11 |
         ddg ok 11 | serper http_4xx(400) 11 | bing http_5xx 9
```

**F.5 Seeded-lead specimens**
```
broken bet: 842f75db… | capperledger | sport Unknown | straight | source twitter_vision |
  result void | "Auto-voided: sport=Unknown not in supported set" | review_status auto_void_unscoped_bet
trace: RECEIVED{textLen:194,imageCount:1} → AUTHORIZED → EXTRACTED → PARSED{source:"escape_hatch"}
  → VALIDATED{sport:"Unknown"} → STAGED   (2026-05-13 13:21; grading_audit rows: 0)
storm date ranges: 5896733c 2026-04-11→04-14 (1468 rows); 1beeceb1 2026-04-10→04-12 (204)
DUPLICATE_REPOST drops 30d: 0
drop_reason 7d top: BOUNCER_REJECTED 1854 | GRADE_AI_PENDING_NO_DATA 1152 | GRADE_TOO_RECENT 807 |
  PRE_FILTER_NO_BET_CONTENT 213 | GRADE_PENDING_UNCLASSIFIED 60 | GRADE_BACKOFF_EXHAUSTED 21
```

**F.6 DB size + mode flags**
```
$ fly ssh console -C "sh -c 'du -h /data/bettracker.db; ls -lh /data/; echo …flags…'"
 38M /data/bettracker.db | bettracker.db-wal 40M | bettracker.db-shm 32K | bets.db 0 (May 12)
 QUOTE_BOUND_GRADING=   GEMMA_FALLBACK_DISABLED=true   AUTOGRADER_DISABLED=false   TWITTER_POLLER_DISABLED=true
```

**F.7 Odds API round-trip (status only, key never printed)**
```
$ fly ssh console -C "sh -c 'cd /app && node -e \"…fetch(api.the-odds-api.com/v4/sports/?apiKey=$ODDS_API_KEY)→print(r.status)…\"'"
HTTP 200
```

**F.8 Gate 3 firing check (7d)**
```
$ fly ssh console -C "sh -c 'cd /app && WIN_H=168 node scripts/gate3-firing-check.js'"
window 168h — distinct bet+leg | non-PENDING grades: 145
  Gate 3 evaluated: 46   (passed 45 / would-fire 7)
provider_used of non-PENDING: espn 105 | groq-llama4-scout 48 | mlb_statsapi 10
```

**F.9 Surface Pro**
```
$ ssh tracker@tracker-surface-pro pm2 ls
 ollama-proxy 13h ↺0 | zonetracker-dashboard 13h ↺0 | zonetracker-dubclub 6h ↺4 |
 zonetracker-ocr 13h ↺0 | zonetracker-scraper 13h ↺0   (all online)
checkouts: dashboard /home/tracker/zonetracker-dashboard @409fee4 main clean = clone origin/main ✓
           dubclub   /home/tracker/zonetracker-dubclub   @31e7166 main clean ✓ (canonical)
           scraper   /home/tracker/zonetracker-scraper   @6743106 main clean ✓
ecosystem files: ollama-proxy, dashboard, ocr, scraper — dubclub MISSING
env key names (values stripped remotely): dashboard ecosystem NODE_ENV → runtime HAS NODE_ENV ✓;
  scraper ecosystem NODE_ENV → runtime LACKS NODE_ENV (drift); dubclub: dotenv-only (.env present, gitignored)
disk: repos 4.9M/29M/31M (+ocr 423M, stats 23M); ~/.pm2/logs 41M
  (dubclub-error 16M, scraper-out 15M, dubclub-out 11M); df / 17% used, 184G free
dubclub error tail: repeated "IMAP connection closed. Exiting so PM2 can restart." (11× Jun 9-10)
  + "FATAL: Error: getaddrinfo EAI_AGAIN imap.gmail.com" (2×)
no pm2-logrotate module (only Module: ollama-proxy)
```

**F.10 Worktrees**
```
$ git -C ~/Documents/discord worktree list
 main@84650b8 | 2b2-fetch-retry@1969a68 [feat/2b2-fetch-retry — STALE, #65 merged] |
 beautiful-heyrovsky@84650b8 | coa-full-audit@84650b8 [this audit] | dreamy-hugle@84650b8
```

**F.11 Tests (audit worktree, NODE_PATH → main checkout node_modules)**
```
$ npm run check        → EXIT=0
$ npm run test:reliability → EXIT=0  (29 migrations applied on fresh DB; …;
  slip-multi-image (F-07): 13 passed / 0 failed)
```

**F.12 Satellite test/secret summaries** — dashboard: `npm ci` clean, `npm test` **35/35 pass**, no credentialed tests skipped (self-stubbed); secret-grep over all revisions: 0 hits. dubclub: `node tests/split-picks.test.js` **8/8**; `npm test` missing (U-12); all-history file scan: no storageState/.env/cookie/token file ever committed. scraper: no tests; `node --check` clean ×2; all-history scan: no cookie/session/db file ever committed; `.env.example` real burner username/email since `151e681` (S-05; values withheld).

**MISSING items** (forbidden or out of scope this run, with the obtaining command): Tailscale serve/funnel mapping check on the Surface Pro (`tailscale serve status && tailscale funnel status` — relevant to D-2's compensating control); host Node ≥20.12 for dashboard `process.loadEnvFile` (`node -v` on the box); pinned-tweet `socialContext` over-match check (Playwright probe in scraper transcript).
