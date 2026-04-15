# ZoneTracker Backlog

## 🚨 KNOWN BUG - Priority 1

### DatDude #datdude-slips Hard Rock bet slips not staging to war-room

**Symptom**: DatDudeStill posts Hard Rock Bet shares in #datdude-slips. Bot receives message, extracts image attachment, calls Vision AI. But no bet appears in war-room. Same user posting same content in #ig-dave-picks works fine.

**Verified NOT the cause**:
- MessageHandler.ENTRY fires for both channels (author=datdudestill reaches bot)
- Both channels in HUMAN_SUBMISSION_CHANNEL_IDS
- Both channels in CAPPER_CHANNEL_MAP (1473347391284576469:IgDave, 1355182920163262664:DatDude)
- Neither in IGNORED_CHANNELS
- Image extraction succeeds: "Images Extracted: 1" for both
- Vision AI fires for both (5-sec buffer delay from 20:07:33 datdude → 20:07:38 vision call)
- resolveCapper() returns valid capper info for both (DatDude, IgDave)
- No channel-specific branching in processAggregatedMessage or bufferMessage

**Next debug steps when resumed**:
1. Add log line inside processAggregatedMessage right after "[DEBUG] AI Response:" showing channel name + bets.length
2. Add log line before any return/drop in the war-room staging path
3. Have DatDude post ONLY in #datdude-slips (no concurrent #ig-dave-picks post within 10s to rule out buffer collision)
4. Immediately grep logs for full trace from ENTRY → AI Response → staged/dropped
5. HRB-DIAG logging already live (commit 43b59e3) — keep it

**Hypothesis**: Post-Vision-AI bet creation path has a silent drop for second channel in HUMAN_SUBMISSION_CHANNEL_IDS, OR buffer key collision drops one when both post near-simultaneously.

## Grading Enhancements

### Oracle: CapperLedger as grading source
Parse @capperledger recap tweets to grade pending bets without AI calls. Add `grading_source` column. Fuzzy-match bet descriptions. Threshold >85% confidence. Fallback to AI after 24h.

### City-name ambiguity in reclassifier
The SPORT_TEAM_KEYWORDS list only contains team nicknames (Thunder, Lakers, Capitals), not city names (Oklahoma City, Los Angeles, Washington). When a bet uses the city name alone ("Oklahoma City to win"), the reclassifier fails to match it against the correct sport. This is especially problematic for cities with multiple teams across sports (LA has 8+ pro teams). Fix: add city aliases to each sport's keyword list, OR implement a disambiguation step that checks all sports and flags truly ambiguous cities as "requires-context" rather than forcing a reclassification.

### Capper ROI display bug
`/admin snapshot` shows Top 3 cappers all at "+500%" ROI (rbssportsplays, dangambleai, Dan). Suspiciously uniform cap or calculation error. Investigate ROI formula in snapshot handler and `/health quick` — likely capping at 500% or dividing by wrong denominator. Should show actual ROI per capper.

### Brave Search returning HTTP 402 — free tier exhausted or API key issue
Grader logs show 100% HTTP 402 responses from Brave backend. DDG circuit breaker is open. Only Bing fallback is returning results. Need to: (1) verify BRAVE_API_KEY is still valid, (2) check Brave dashboard for usage/billing status, (3) circuit-breaker Brave on 402 like we do for DDG timeouts, (4) add 402 detection to Brave health check so /admin snapshot reflects real state.

### Snapshot Brave health check is wrong
/admin snapshot reports "Brave: healthy" while actual calls return HTTP 402. The circuit tracker only detects timeouts, not HTTP error codes. Fix: track 4xx/5xx responses as circuit failures. Show real last-success timestamp per backend.

### Action-keyword validation (P2 follow-up to sport consistency)
Current validateLegSportConsistency() only checks team keywords. Player-only props with cross-sport action words (e.g. "Matt Turner Goalie Saves" in a LoL parlay, "Emmet Sheehan Pitching" in a Soccer parlay) can evade detection if no team names appear. Add a second validator that checks action/prop keywords per sport: soccer=goalie saves/corners/yellow card, mlb=pitching/strikeouts/RBIs, nba=rebounds/assists/PRAs, nhl=saves/shots on goal, etc. Action-keyword mismatch against declared parlay sport = reject.

## Ingestion Expansion

### DubClub email → Discord bridge
Enable per-capper emails in DubClub. Gmail filters → Discord webhook per capper → ingestion pipeline. Bouncer update for email format. Capper attribution via webhook source.

## Infrastructure

### Jarvis feature suite (LLM features)
- Daily props picks
- Parlay builder
- Pick of the day
- Alt lines analyzer
- Safe locks
- EOD P&L recap
- Slip analyzer (paste a screenshot, get EV analysis)
- Bankroll sizing recommendations

### Sports stats API integration
- Ball Don't Lie (free NBA)
- L5/L10/L20 hit rates per player
- Defense rank by position
- Home/away splits
- Usage/minutes trends
- Back-to-back flags
- Injury context from news

### Profit tracker visual dashboard
ROI charts, capper leaderboards with date ranges, unit tracking

### Edit modal: parlay ↔ singles conversion
Let user split a parlay into singles or merge singles into a parlay from the war room embed

## Foundation

### Grading audit table
Full decision trail per grading attempt. Admin command to dump trail for any bet ID.

### State snapshot admin command
`/admin snapshot` → dumps full bot state in one message

### CI reliability gate
GitHub Actions workflow that blocks PRs on failing `npm run check` + `npm run test:reliability`

### Deploy verification protocol
`docs/DEPLOY_CHECKLIST.md` required for every non-trivial deploy

### README comprehensive documentation
Architecture, env vars, admin commands, scraper setup, troubleshooting, guard chain reference

## Surface Pro

### Scraper (building now)
Target 8 handles without TweetShift coverage

### Local Ollama for free AI grading
Offload grading AI calls from Groq to local Ollama instance. Zero marginal cost. Slower but unlimited.


### Gemma 4 E4B for local vision OCR fallback
Evaluate `gemma4:e4b-it-q4_K_M` on Surface Pro 5 Ollama (~5GB RAM at Q4, CPU-only) as fallback path for dense Hard Rock Bet slips that defeat current Gemini Vision preprocessing — the failure mode flagged in Day 6 audit. Native multimodal with configurable 1120-token OCR budget designed for small-text document parsing. Apache 2.0, function calling, native thinking modes. Secondary use: upgrade grader fallback tier (`ollama-llama3.2-3b` → `gemma4:e4b`); E4B inherits Gemini 3 research lineage and is meaningfully stronger than llama3.2:3b at reasoning. P0 (state machine + canFinalizeBet) shipped in v276 — hold this until P1 (pipeline_events + silent drop fixes) is done.
### Sports data caching
Nightly precompute of hit rates, trends, splits. Cached locally, served to Fly bot on demand via Tailscale.
