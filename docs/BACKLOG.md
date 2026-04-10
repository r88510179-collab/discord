# ZoneTracker Backlog

## Grading Enhancements

### Oracle: CapperLedger as grading source
Parse @capperledger recap tweets to grade pending bets without AI calls. Add `grading_source` column. Fuzzy-match bet descriptions. Threshold >85% confidence. Fallback to AI after 24h.

### City-name ambiguity in reclassifier
The SPORT_TEAM_KEYWORDS list only contains team nicknames (Thunder, Lakers, Capitals), not city names (Oklahoma City, Los Angeles, Washington). When a bet uses the city name alone ("Oklahoma City to win"), the reclassifier fails to match it against the correct sport. This is especially problematic for cities with multiple teams across sports (LA has 8+ pro teams). Fix: add city aliases to each sport's keyword list, OR implement a disambiguation step that checks all sports and flags truly ambiguous cities as "requires-context" rather than forcing a reclassification.

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

### Sports data caching
Nightly precompute of hit rates, trends, splits. Cached locally, served to Fly bot on demand via Tailscale.
