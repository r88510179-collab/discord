# PR_SPEC.md

## Title
Team and Player Name Normalization

## Problem
The AI parser currently outputs whatever name it finds in the text (e.g., "GSW", "Warriors", "Dubs"). This makes it impossible to aggregate stats or search for "Golden State Warriors" bets reliably.

## Scope
- Create `data/mappings/teams.json` containing key-value pairs (e.g., "LAL": "Los Angeles Lakers").
- Create `services/normalization.js` with a `normalizeTeam(name)` and `normalizePlayer(name)` function.
- Update `services/ai.js` to run the AI output through these normalization functions before saving to the database.
- Add a new migration `migrations/003_normalize_existing_data.sql` (optional, for later).

## Acceptance Criteria
- [ ] "LAL" and "Lakers" both resolve to "Los Angeles Lakers" before database insertion.
- [ ] Normalization logic handles case-insensitivity.
- [ ] `npm run test:reliability` passes with new test cases for different team aliases.