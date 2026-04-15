# ZoneTracker — Start of Day Apr 16 2026

## Yesterday recap (Apr 15)

Shipped 5 deploys: v275/v276 (P0 grading state machine + unified channel auth), v277 (sportsbook brand exemption), v278 (Brave circuit breaker + backendHealth), v279 (per-backend cooldown config). Surface Pro scraper interval bumped from */30 to */5.

Key finding: Pre-filter is working correctly. The real intake leak is Gemini Vision producing "missing legs / capper hid in image" placeholder for dense slip images. Confirmed ~10 real bets/week lost. Verified Gemma 3:4b on Surface Pro Ollama can read these slips locally.

## Today main goal

Wire Gemma 3:4b into services/ai.js Vision waterfall as fallback after Gemini Vision. Estimated 4-5 hours.

## Decisions locked Apr 15

1. Trigger: Gemma fires only when Gemini returns placeholder text matching /missing legs|capper hid|cannot read/i AND parser validation fails
2. Output: Two-stage. Gemma extracts text from image, Cerebras parses Gemma text into structured bet legs
3. Failures: New vision_failures table for slips that defeat both Gemini AND Gemma
4. Latency: Accept 30-90s synchronous Gemma call. No async queue.
5. Validation: tests/vision-fixtures incrementally. Don't block initial wiring on it.

## Test fixtures available

8 unique slip images in ~/Documents/discord/test-fixtures/vision/ saved Apr 15.
- 2043731379188322388.jpg through 2044435030047399999.jpg (zrob4444 PrizePicks slips)
- Naming: tweet IDs from x.com URLs

## Implementation order

1. Migration 017: vision_failures table, schema only, 30 min
2. Add Ollama Vision provider class to services/ai.js, 1 hr
3. Wire conditional trigger + two-stage flow in services/twitter-handler.js, 1.5 hr
4. Test against saved fixtures, 30 min
5. DEPLOY_CHECKLIST verification, 30 min

## Pre-deploy auth check

fly ssh console -a bettracker-discord-bot -C "printenv OLLAMA_URL OLLAMA_PROXY_SECRET"

Both must be present. Same auth path as llama3.2:3b grading fallback already uses.

## Two-stage flow shape

Tweet with image -> Gemini Vision (existing path) -> if returns placeholder AND parser fails -> Gemma 3:4b via Ollama proxy: "Read this betting slip image. Output raw text of every pick: player name, stat, line, odds. No formatting." -> free text response -> Cerebras: "Parse this text into JSON array of bet legs. {legs: [{description, odds, units}]}" -> structured JSON -> existing bouncer/parser path.

If Gemma response is empty OR Cerebras can't parse -> log to vision_failures table, give up, bouncer rejects as before. No regression.

## Things NOT to touch today

- DDG/Bing/Serper search backends (v279 current)
- Channel auth (v276 solid)
- Grading state machine (v275 solid)
- Pre-filter (audit confirmed working)
- commands/admin.js beyond what Gemma needs

## Open BACKLOG items - don't touch today

- Brave 402 actual quota issue
- ESPN API integration
- Junk bet auto-reject
- Dashboard migration to grading_state aware
- DatDude P1 (needs DatDude to post)
- Cross-sport parlay handling
- bookitwithtrent inline-text bet missed

## Status check first thing

fly status -a bettracker-discord-bot

Expected pending counts roughly: ~22 backoff, ~9 quarantined. If wildly different, debug first.

## Verification queries before starting Gemma

Confirm v277 brand exemption stayed clean over 24h:
fly ssh console -a bettracker-discord-bot -C 'node -e "const db=require(\"better-sqlite3\")(\"/data/bettracker.db\"); const r=db.prepare(\"SELECT COUNT(*) c FROM twitter_audit_log WHERE stage=bouncer_rejected AND reason LIKE %sportsbook_brand% AND created_at > datetime(now,-24 hours)\").get(); console.log(r.c);"'

Confirm Brave breaker still firing:
fly logs -a bettracker-discord-bot --no-tail | grep -E "Brave.*Circuit breaker OPEN" | tail -5

## Codex audit findings (Apr 15 close-out)

Audit clean: 0 blockers. Two HIGH items to decide on FIRST tomorrow morning, before Gemma work:

### HIGH #1 - Check for orphan capper channels (5 min decision)

Run this before doing anything else:
fly ssh console -a bettracker-discord-bot -C 'node -e "const m=process.env.CAPPER_CHANNEL_MAP||\"\"; const p=(process.env.PICKS_CHANNEL_IDS||\"\").split(\",\"); const h=(process.env.HUMAN_SUBMISSION_CHANNEL_IDS||\"\").split(\",\"); const allowed=new Set([...p,...h,process.env.SUBMIT_CHANNEL_ID,process.env.SLIP_FEED_CHANNEL_ID].filter(Boolean)); const orphans=m.split(\",\").map(s=>s.split(\":\")[0]).filter(c=>c && !allowed.has(c)); console.log(\"Orphan capper channels:\", orphans);"'

If output is []: bug is latent, document in BACKLOG, defer.
If output has channel IDs: those cappers are silently denied. Fix BEFORE Gemma. Add CAPPER_CHANNEL_MAP IDs to globalPipelineGuard's allowed set.

### HIGH #2 - Brand exemption breadth (defer until after Gemma)

Codex flagged that hasMedia OR slipShape is too permissive (FanDuel promo image tweets pass brand check). Counter-context: zrob4444 dense slips have no inline text — requiring AND would re-break the recovery we just shipped. Wait until Gemma is wired; then the second-stage parser becomes the safety net and we can tighten brand exemption to AND. Document in BACKLOG.

### MEDIUM items - add to BACKLOG, fix opportunistically

- /admin grading-unstick prefix match - require 8+ char prefix or exact ID. 5 min fix.
- Migration 016 backfill resume - permanent skip if budget exhausted. Edge case.
- Composite grading index unused per EXPLAIN QUERY PLAN - dead weight, low priority.
- Test seed inserts bypass grading_state='ready' - matters when state machine tests exist.

### LOW/NIT - all confirmed working as intended

- canFinalizeBet TOCTOU benign (atomic finalize wins)
- backendHealth races benign (Node single-threaded)
- /admin snapshot exposes no secrets

### Test infra issue (pre-existing, not from today)

npm run test:reliability fails in tests/migration-validation.js expecting 006_add_season_to_bets.sql but file is 006_add_season_column.sql. Migration was renamed at some point, test wasn't updated. Add to BACKLOG for next time we touch test suite.
