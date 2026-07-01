# Season Reset (fresh-slate reporting)

> DOCS ONLY. Line numbers verified against the `main`-tracked source in this checkout on **2026-07-01**. `services/database.js` and `bot.js` move often — re-run the Step-1 greps in `prompts/document-season-reset.md` (or `grep -n ACTIVE_SEASON services/database.js`) before trusting a number.

## What it is
Reporting reset without deleting data. Bump `ACTIVE_SEASON`: new bets tag under the new label, old rows keep their tag, capper stats + leaderboard scope to the active season automatically.

## Why season — not a new epoch flag, not a delete
- `ACTIVE_SEASON` (`services/database.js:175`, `process.env.ACTIVE_SEASON || 'Beta'`) is env-driven → `fly secrets set` + machine bounce, **NO redeploy**.
- Stamped at insert: `createBet` binds `betData.season || ACTIVE_SEASON` (`database.js:378`) into the `insertBet` prepared statement (`database.js:185`). Non-destructive; historical rows keep their existing tag.
- Both reporting fns already scope on `AND b.season = ?` bound to `ACTIVE_SEASON`:
  - `getCapperStats` — fn `database.js:804`, `LEFT JOIN bets b … AND b.season = ?` at `:811`, bound `.get(ACTIVE_SEASON, capperId)` at `:814`.
  - `getLeaderboard` — fn `database.js:820`, filter at `:830`, bound `.all(ACTIVE_SEASON, limit)` at `:835`.
- The ENTIRE `CAPPER_STATS_COLUMNS` block (`database.js:780`) — `wins`/`losses`/`pushes`/`win_pct`/`total_profit_units`/`roi_pct` — is interpolated verbatim into that one season-gated query in both fns, so counts and ROI scope together. **No count-vs-ROI split.**
- Auto-covers every consumer of those two fns: `/leaderboard` (`commands/leaderboard.js`), `/stats` (`commands/stats.js`), `/recap` slash command (`commands/recap.js`), `healthReport` (`services/healthReport.js`), `warRoom` (`services/warRoom.js`), `/admin` leaderboard views (`commands/admin.js`), `services/dashboard.js`, and `saveDailySnapshot` (`database.js:924`).
- Column backed by `migrations/006_add_season_column.sql` + a boot-time additive guard (`database.js:62`, `if (!betCols.includes('season')) … ADD COLUMN season TEXT NOT NULL DEFAULT 'Beta'`).

## Procedure
1. Pick a label (e.g. `2026-07`, `S2`).
2. `fly secrets set ACTIVE_SEASON=<label> -a bettracker-discord-bot`  (bounces the machine)
3. Verify in container: `fly ssh console -C "printenv ACTIVE_SEASON" -a bettracker-discord-bot`
4. Confirm stamping after the next ingest: `SELECT season, COUNT(*) FROM bets GROUP BY season;`

Reversible: set `ACTIVE_SEASON` back to the prior label to view the old season.

## Bypass sites — stay ALL-TIME after a bump (do NOT honor season)
- `bot.js:322` — the all-time `SUM(b.profit_units)` line in the `!leaderboard` text command (command guard `bot.js:314`); `WHERE b.result IN ('win','loss','push')` only, no season.
- `bot.js:467` — the all-time `SUM(b.profit_units)` line in the `!reset_season` podium (command guard `bot.js:462`, top-3, admin-only); no season.
- `services/database.js:267` — the all-time `SUM(profit_units)` line inside the `dashboardSummary` prepared stmt (stmt head `:261`; x-ray + Surface Pro dashboard feed); filters `WHERE review_status = 'confirmed'` only (`:268`), no season.
- `services/database.js:1079` — the all-time `totalProfit` reduce inside `getCapperAnalytics` (fn `:1071`); feeds off the `capperGradedBets` prepared stmt (`:279`), called `.all(capperId)` at `:1072` with **no season bind**.

Open decision per site: season-gate it, or keep as an intentional all-time view. NOTE: `dashboardSummary` feeds the operator UI, so the dashboard shows all-time totals until gated.

## NOT a bypass
- `bot.js:720` — the daily recap (cron registered at `bot.js:711`) is a 24h rolling window (`WHERE graded_at >= datetime('now','-1 day')` at `:723`), season-independent by design. Distinct from the season-scoped `/recap` slash command (`commands/recap.js`).

## Caveat — snapshot/bankroll divergence
`saveDailySnapshot` (`database.js:923`) pulls `getCapperStats` (`:924`), so post-bump snapshots record new-season profit while `bankrolls.current` keeps accumulating unscoped. Snapshot P/L and bankroll diverge at the reset boundary. Only matters if snapshots are read across the line.

## Known footgun (separate cleanup)
Two migrations share number 006, both `ALTER TABLE bets ADD COLUMN season`: `006_add_season_to_bets.sql` and `006_add_season_column.sql`. The migrator tracks by **filename**, not by number (`services/migrator.js:24` PK, `:42-44` sorted discovery), so **both** run: alphabetically `006_add_season_column.sql` applies the column first, then `006_add_season_to_bets.sql` throws `duplicate column name`. What prevents a hard boot failure is the migrator's own duplicate-column tolerance (`migrator.js:61-71`, which swallows that error and marks the file applied) — **not** the `database.js:62` boot guard. That boot guard runs *after* `runMigrations(db)` (`database.js:19`), so by the time it checks, the column already exists and `if (!betCols.includes('season'))` is false: an inert no-op for this collision (it's a belt-and-suspenders fallback for a fresh/legacy DB, not the masker). The duplicate number is still a latent collision — reconcile in a migration-hygiene pass (tracked in `docs/BACKLOG.md`).
