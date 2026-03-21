# PR_SPEC.md

## Title
Add admin audit mode with War Room interactive UI

## Problem
There is no way for admins to globally force all incoming bets into a review queue, and no interactive UI for reviewing staged bets in real time.

## Why it matters
Audit mode gives admins a kill-switch to hold all bets for manual review during high-risk periods (e.g., new capper onboarding, system changes). The War Room UI provides an interactive embed-based workflow (Approve/Edit/Reject) directly in Discord, eliminating the need for slash commands for common review actions.

## Scope
1. **Settings table** — Migration `003_add_settings_table.sql` with `audit_mode` defaulting to `on`
2. **`/admin audit on|off`** — Slash command to toggle audit mode (Administrator only)
3. **Audit mode logic** — When audit mode is on, ALL new bets are routed to `needs_review` regardless of confidence
4. **War Room staging embeds** — `sendStagingEmbed()` posts an embed with Approve/Edit/Reject buttons to `ADMIN_LOG_CHANNEL_ID`
5. **Interaction handler** — `handleWarRoomInteraction()` handles button clicks and edit modal submissions
6. **Edit modal** — Discord modal with Team Name, Betting Line, and Odds fields
7. **Bot wiring** — `bot.js` routes `war_*` interactions to the handler before slash commands

## Non-goals
- Do not modify parsing, normalization, or grading logic
- Do not build a web dashboard

## Files touched
- `services/database.js` — getSetting, setSetting, isAuditMode, updateBetFields + prepared statements
- `services/warRoom.js` — NEW: sendStagingEmbed, handleWarRoomInteraction
- `commands/admin.js` — NEW: /admin audit on|off
- `migrations/003_add_settings_table.sql` — NEW: settings table
- `handlers/messageHandler.js` — audit mode check, war room staging embeds
- `bot.js` — war room interaction routing
- `tests/audit-mode-validation.js` — NEW: 6 tests
- `tests/message-handler.integration.js` — added isAuditMode and warRoom mocks
- `tests/migration-validation.js` — updated migration count from 2 to 3
- `package.json` — updated check and test:reliability scripts

## Required validation
- `npm run check`
- `npm run test:reliability`

## Acceptance criteria
- [ ] Settings table exists with audit_mode = 'on' by default
- [ ] `/admin audit on|off` toggles audit mode
- [ ] Audit mode ON routes all bets to needs_review
- [ ] Staging embeds appear in ADMIN_LOG_CHANNEL_ID with 3 buttons
- [ ] Approve updates embed green, posts to dashboard
- [ ] Edit opens modal, refreshes embed with new values
- [ ] Reject deletes bet, updates embed red
- [ ] `npm run check` and `npm run test:reliability` pass
