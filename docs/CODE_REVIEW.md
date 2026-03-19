# CODE_REVIEW.md

## Fixed in the codex-ready consolidation pass
- Fixed the broken `npm run deploy` script path in `package.json`.
- Added `npm run check` and kept validation explicit for Codex.
- Added a lightweight HTTP health server so Fly's `internal_port` points to a real listener.
- Updated `fly.toml`/runtime assumptions for the Fly + Docker deploy path.
- Updated `.env.example` to better match the actual code paths and provider names.
- Added safer display-name helper patterns to reduce fragile Discord lookup behavior.
- Rewrote the README around the real Node/Fly/SQLite runtime.

## Reliability work completed after handoff
- Added DB-level dedupe using fingerprints for imported picks.
- Added handler-level replay suppression so duplicate messages do not trigger duplicate side effects.
- Added reliability validation for:
  - replayed same-message ingestion
  - text + image overlap on the same message
  - repeated grading pass safety
  - mocked handler-level concurrency replay
  - DB-backed concurrency with worker threads
  - stress-style duplicate insertion under burst conditions
- Hardened SQLite race handling with `busy_timeout` and unique-index fallback behavior.
- Improved grading reliability for:
  - totals vs spread parsing overlap
  - odds values being mistaken for lines
  - tokenized moneyline detection
  - simple parlay aggregation
- Added alias-normalization and sport-scoped alias filtering for common shorthand in NBA/NFL/MLB/NHL.

## Still open
- Auto-grading remains heuristic and is still limited for props, alt markets, and complex parlays.
- Team/event matching is improved but still heuristic.
- Twitter/X support depends on current API access and token availability.
- There is still no broad end-to-end Discord integration suite with live API/network behavior.
- Schema evolution is additive/manual rather than a formal migration framework.
