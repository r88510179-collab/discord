# DatDude Silent Drop — Trace-Diff Runbook

Use when a Hard Rock share posted in #datdude-slips fails to stage in war-room while the same content posted in #ig-dave-picks succeeds.

## Phase 1: Verify pipeline_events instrumentation

In Discord, run `/admin pipeline-drops-24h`. Note any expected stage with zero entries — that's a likely instrumentation gap, not necessarily a real perfect-success stage.

Cross-check against the bot's startup log:

    fly logs -a bettracker-discord-bot --no-tail | grep PIPELINE_INSTRUMENTATION | tail -5

If `PIPELINE_INSTRUMENTATION_GAP` appears with `silent_stages` populated, fix instrumentation before continuing. The trace diff in Phase 2 is meaningless if the broken path traverses an uninstrumented stage. The expected stages are `DROPPED`, `GRADING_AI`, and `GRADING_DROPPED` — all three should produce drop events in any active 24h window.

## Phase 2: Working-vs-broken trace diff

1. Post identical Hard Rock share in #ig-dave-picks (control) and #datdude-slips (variable). Same image, same caption if any.
2. Copy both Discord message IDs (Developer Mode → right-click → Copy Message ID).
3. Convert each Discord message ID to its ingest_id by prefixing `disc_` (the bot uses `makeIngestId('discord', msgId)` → `disc_<msgId>`).

In Discord:

- `/admin pipeline-trace ingest_id:disc_<IGDAVE_MSG_ID>`
- `/admin pipeline-trace ingest_id:disc_<DATDUDE_MSG_ID>`

Or via SSH for a clean diff:

    fly ssh console -a bettracker-discord-bot -C "sqlite3 /data/bettracker.db \"SELECT datetime(created_at,'unixepoch'), stage, event_type, drop_reason FROM pipeline_events WHERE ingest_id = 'disc_<IGDAVE_MSG_ID>' ORDER BY created_at, id;\"" > /tmp/working.txt

    fly ssh console -a bettracker-discord-bot -C "sqlite3 /data/bettracker.db \"SELECT datetime(created_at,'unixepoch'), stage, event_type, drop_reason FROM pipeline_events WHERE ingest_id = 'disc_<DATDUDE_MSG_ID>' ORDER BY created_at, id;\"" > /tmp/broken.txt

    diff /tmp/working.txt /tmp/broken.txt

**The first stage where they diverge names the bug.** A control trace that ends at `STAGED` while the broken trace ends at `RECEIVED` says the divergence is between RECEIVED and AUTHORIZED. A control trace that includes `EXTRACTED → PARSED` while broken ends at `EXTRACTED` says vision succeeded but parsing dropped silently.

If the broken trace has **zero rows**, the message never reached MessageHandler — check channel-allowlist gating before instrumentation runs.

## Phase 3: Hypothesis ladder (use only after Phase 2 narrows the stage)

Likely candidates given current evidence:

- **Buffer key collision.** If BufferCoalescer keys on `(user_id, image_hash)` instead of `(channel_id, user_id, image_hash)`, the second post latches onto the first buffer entry. Check the buffer key construction.
- **Channel gate asymmetry.** `HUMAN_SUBMISSION_CHANNEL_IDS`, `CAPPER_CHANNEL_MAP`, and any Hard Rock detector channel set are three separate lists. If #datdude-slips appears in two but not the third, the third is the gate. There is channel-specific branching somewhere — find which list is missing the entry.
- **Hard Rock detector special path.** Grep for "hard rock" / "HRB" / channel allowlists in vision and staging. Likely added when Hard Rock support was first prototyped on #ig-dave-picks and never generalized.
- **Foreign-key constraint silent fail.** If #datdude-slips resolves to a `capper_id` that doesn't exist in `cappers` (alias issue), an unwrapped INSERT on a child table can silently drop. Verify the `capper_id` for DatDude exists:

      fly ssh console -a bettracker-discord-bot -C "sqlite3 /data/bettracker.db \"SELECT * FROM cappers WHERE name LIKE '%datdude%' COLLATE NOCASE;\""

## Phase 4: Anti-pattern

Do not add a "DatDude special case." The bug is structural — some logic differs between channels for no defensible reason. Find the asymmetry and remove it. If the fix looks like adding a channel ID to a list, ask why that list is not computed from `CAPPER_CHANNEL_MAP`.
