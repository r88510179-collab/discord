# PR_SPEC.md

## Title
Add admin commands for the manual review queue

## Problem
PR #5 successfully routed low-confidence bets to a `needs_review` state in the database, but there is currently no way for an admin to view, approve, or reject these bets from within Discord.

## Why it matters
Without a UI to clear the review queue, flagged bets will accumulate silently and users will wonder why their picks weren't recorded.

## Scope
- Create a new Discord slash command group: `/review`.
- Subcommand `/review list`: Shows a list of pending bets currently in `needs_review` status (include the Bet ID, user, and text).
- Subcommand `/review approve <bet_id>`: Changes a bet's status from `needs_review` to `confirmed` and triggers the public announcement in the picks channel.
- Subcommand `/review reject <bet_id>`: Deletes the flagged bet from the database (or marks it as rejected/invalid).
- Ensure these commands are restricted to users with Admin permissions.
- All responses should be ephemeral (only visible to the admin).

## Non-goals
- Do not build a web UI or dashboard.
- Do not modify the existing parsing or AI confidence logic.
- Do not modify grading logic.

## Likely files touched
- `commands/review.js` (new file)
- `services/database.js` (add queries for fetching, approving, or rejecting review bets)

## Required validation
- `npm run check`
- `npm run test:reliability`

## Acceptance criteria
- [ ] `/review list` successfully retrieves low-confidence bets from SQLite.
- [ ] `/review approve` successfully updates the DB and posts the bet.
- [ ] `/review reject` successfully removes or invalidates the bet.
- [ ] Commands are restricted to authorized admins.
- [ ] `npm run check` and `npm run test:reliability` pass.