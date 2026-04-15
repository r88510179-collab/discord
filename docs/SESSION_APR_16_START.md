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
