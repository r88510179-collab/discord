# CURRENT_STATE.md

## Project summary
BetTracker Discord Bot is currently standardized around a **Node.js + Fly.io + Docker + SQLite** architecture.
The repo has been prepared for agent-driven development with Codex-style instructions and a small-PR workflow.

## Current runtime shape
- **Runtime:** Node.js
- **Deploy target:** Fly.io
- **Container path:** Dockerfile-based deploy
- **Persistence:** SQLite on `/data`
- **Bot model:** single-process Discord bot with slash commands, message ingestion, cron jobs, grading, and dashboard posting

## High-level flow
### Entry/runtime
`bot.js` initializes the Discord client, loads commands, wires message ingestion, and schedules cron jobs for grading and related automation.

### Ingestion
`handlers/messageHandler.js` is the main auto-ingest path for message-based picks and slip-driven inputs.

### Parsing / AI
`services/ai.js` handles:
- regex fast-path parsing
- LLM-based parsing for harder cases
- slip OCR extraction
- normalization and safer JSON extraction behavior

### Persistence
`services/database.js` manages SQLite writes for bets, cappers, bankroll data, parlay legs, and related metadata.

### Grading
`services/grading.js` manages pending-bet lookup, score-based grading attempts, and result writes.

## What has been improved recently
### Ingestion / dedupe reliability
- DB-level fingerprint dedupe was added.
- Replay-safe handler behavior was added.
- Text plus image overlap on the same message now dedupes correctly.
- Concurrency fallback behavior was added for unique-index races.
- Duplicate leg insertion paths were guarded.

### Validation
The repo now includes a repeatable reliability suite that covers:
- replayed same-message ingestion
- text plus image overlap
- repeated grading-pass safety
- mocked handler concurrency replay
- DB-backed concurrency validation
- burst-style duplicate insertion stress validation
- grading validation
- alias and shorthand matching validation

### Grading correctness
- totals vs spread misclassification was tightened
- odds tokens are less likely to be mistaken for lines
- ML and O/U token handling was improved
- simple parlay aggregation was added
- alias normalization was added for common NBA, NFL, MLB, and NHL shorthand
- sport-scoped alias filtering was added to reduce cross-league over-matching

## Current strengths
- Much stronger idempotency and duplicate-ingestion protection
- Better grading correctness for common straightforward markets
- Better repo readiness for Codex and agent workflows
- Cleaner Fly deploy path and docs

## Current risks
- Complex props, alt lines, and deep parlay settlement are still limited
- Team and event matching is still heuristic
- Alias coverage is intentionally compact, not exhaustive
- Full live Discord and network behavior is not covered by an end-to-end suite
- Higher-scale distributed contention is still not fully proven

## Recommended planning posture
The project is close to the point where implementation should shift from **core reliability hardening** to **roadmap planning and bounded feature work**.

## Recommended next milestone areas
1. Stabilization complete and bug-driven fixes only
2. Feature completion for grading and analytics
3. Deployment readiness and observability
4. Production monitoring and feedback loop from real misses

## Suggested next small PR direction
If more implementation work is needed immediately, the most likely next bounded task is:
- additional context and confidence guards for ambiguous matching when sport context is missing

Otherwise, the higher-value next move is:
- move project planning and prioritization into Gemini
- keep Codex focused on small implementation PRs
