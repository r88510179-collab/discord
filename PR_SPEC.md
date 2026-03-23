# PR_SPEC.md

## Title
Admin Audit & Staging Mode (PR #10)

## Problem
The bot currently auto-posts bets. To ensure 100% accuracy and build trust, the Admin needs to review every bet before it hits the public dashboard.

## Scope
1. **Settings Table:** Add a `settings` table to SQLite with a key `audit_mode` (default to `1` / true).
2. **Admin Command:** Create `/admin audit <on|off>` to toggle this mode (Administrator only).
3. **Logic Reroute:** Update the bet extraction flow:
   - If `audit_mode` is `on`, ALL parsed bets are saved with `status = 'needs_review'`.
   - The bot should NOT post to the `#dashboard` channel automatically in this mode.
4. **Notification:** The bot should send a private confirmation to the user (or the admin log) saying: "Bet saved for review. ID: [id]".

## Acceptance Criteria
- [ ] `/admin audit on` makes all new bets wait for approval.
- [ ] `/admin audit off` returns the bot to "Auto-Pilot" mode.
- [ ] New migration `003_add_settings_table.sql` created.
- [ ] `npm run test:reliability` passes with a staging workflow test.