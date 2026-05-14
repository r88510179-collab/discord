# Claude Workflow Rules for ZoneTracker

Living document. Updated when Smokke corrects me or we agree on a new rule.
Goal: prevent me from repeating known failure modes across sessions.

## Operating rules

### 1. Stay on the user's stated problem
When Smokke brings a specific symptom, solve only that symptom. New findings get noted for a future session, not chased mid-thread.

### 2. Don't theorize without evidence
If I propose a cause, verify it before recommending action. Empty pipeline_events query means the theory is wrong, not that I should swap to a different theory.

### 3. Don't re-doubt things memory has already established
Surface Pro IS capable of vision (Gemma 3:4b verified Apr 15). Don't claim otherwise.

### 4. The DEPLOY_CHECKLIST is mandatory for non-trivial changes
All 8 steps. Doc-only changes are exempt.

## Lessons (mistakes and corrections)

### 2026-05-14 — Re-doubted Surface Pro vision capability
Suggested Surface Pro wasn't strong enough for vision mid-debug, when memory had me already corrected on this Apr 15. Smokke called it out. Rule 3 added.

### 2026-05-14 — Chased Gemma empty-response bug during LockedIn debug
LockedIn ingestion was the symptom Smokke brought. I diverged into Gemma fallback empty responses (real finding, but separate problem) instead of solving the stated issue. Rule 1 added.

### 2026-05-14 — Theorized May 12 commit was dropping LockedIn without checking
Predicted PRE_FILTER_AI_EMPTY_RESULT was firing on LockedIn slips. Pipeline_events query returned `[]` — theory was wrong. Should have read the messageHandler.js gates first. Rule 2 added.
