# PR_SPEC.md

## Title
Prop Engine Overhaul — structured player props

## Problem
Player props are currently stored as flat description strings (e.g., "LeBron James Over 22.5 Points -110"). This makes it impossible to query, filter, or aggregate prop data by player, stat category, line, or direction.

## Why it matters
Structured prop data enables stat-category leaderboards, player-level P/L tracking, line movement analysis, and cleaner UI formatting. It transforms props from opaque text into queryable, actionable data.

## Scope
1. **Database migration** — `004_create_props_table.sql`: new `bet_props` table with `id`, `bet_id` (FK → bets), `player_name`, `stat_category`, `line` (float), `direction` (over/under), and `odds`
2. **Parsing logic refactor** — Update `services/ai.js` so that when a player prop is detected, it extracts structured fields (`player_name`, `stat_category`, `line`, `direction`) into a JSON object on each bet, in addition to the flat description
3. **Saving logic** — Update `services/database.js` with an `insertProp` prepared statement and a `createBetProp()` function; wire it into `createBetWithLegs()` (or call it from messageHandler) so prop data is persisted alongside the bet
4. **UI update** — Update `services/warRoom.js` staging embeds and `services/dashboard.js` pick formatter to display structured props cleanly (e.g., "LeBron James — Points: O 22.5 (-110)")
5. **Tests** — Validate AI extraction of structured prop fields, DB insertion into `bet_props`, migration correctness, and formatted display output

## Non-goals
- Do not modify grading logic (prop grading is a future PR)
- Do not build prop-specific slash commands
- Do not add line movement tracking or historical analysis

## Likely files touched
- `migrations/004_create_props_table.sql` — NEW
- `services/ai.js` — prop field extraction in prompt + response parsing
- `services/database.js` — `insertProp` statement, `createBetProp()`, export
- `services/warRoom.js` — prop-aware staging embed formatting
- `services/dashboard.js` — prop-aware pick display
- `handlers/messageHandler.js` — wire prop saving after bet creation
- `tests/prop-engine-validation.js` — NEW: migration, DB insert, AI extraction tests
- `tests/migration-validation.js` — update migration count from 3 to 4
- `package.json` — add new test/check entries

## Required validation
- `npm run check`
- `npm run test:reliability`

## Acceptance criteria
- [ ] `bet_props` table created by migration with correct schema
- [ ] AI parser extracts `player_name`, `stat_category`, `line`, `direction` from prop text
- [ ] Structured props saved to `bet_props` table linked by `bet_id`
- [ ] War Room staging embeds display props in clean format
- [ ] Dashboard pick announcements display props in clean format
- [ ] All existing tests continue to pass
- [ ] New prop-engine tests pass
- [ ] `npm run check` and `npm run test:reliability` pass
