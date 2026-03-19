# GEMINI_PLAYBOOK.md

## Purpose
Use Gemini to manage the project, not to implement code.

## Inputs Gemini should read first
- `AGENTS.md`
- `README.md`
- `TASKS.md`
- `docs/CURRENT_STATE.md`
- `docs/EXECUTION_BOARD.md`
- `docs/DECISIONS.md`
- `docs/CODE_REVIEW.md`
- `docs/MERGE_DECISIONS.md`
- `docs/LEGACY_FEATURE_MAP.md`

## Gemini responsibilities
- summarize current state
- update Now / Next / Later priorities
- recommend the single best next PR
- write or update `PR_SPEC.md`
- reassess risks after merge

## Standard Gemini prompt
Read AGENTS.md, README.md, TASKS.md, CURRENT_STATE.md, EXECUTION_BOARD.md, DECISIONS.md, and docs/* first.

Then:
1. update the execution board in Now / Next / Later format
2. choose the single best next PR
3. write a PR_SPEC with:
   - problem
   - why it matters
   - scope
   - non-goals
   - likely files touched
   - tests required
   - acceptance criteria
   - risks and rollback notes

Keep recommendations aligned to the current Node/Fly/SQLite architecture.
Prefer small, reviewable PRs.
