# WORKFLOW.md

## Purpose
This document defines the operating workflow for the BetTracker Discord Bot project.

The project uses:
- **Gemini** for planning and project management
- **Claude Code** for implementation
- **Codex** for audit and review
- **GitHub** as the source of truth and handoff point

## Core rules
1. The GitHub repo is the source of truth.
2. Every implementation task must start from a written `PR_SPEC.md`.
3. Gemini does planning only.
4. Claude implements only what is in `PR_SPEC.md`.
5. Codex audits the implementation against `PR_SPEC.md`, `AGENTS.md`, and the repo rules.
6. No broad rewrites unless explicitly approved.
7. Prefer small, reviewable PRs.
8. Required checks for implementation and audit:
   - `npm run check`
   - `npm run test:reliability`

## Roles
### Gemini — project manager
Gemini should:
- read the planning docs first
- maintain the execution board
- recommend the next best PR-sized task
- write or update `PR_SPEC.md`
- update project state after merge

### Claude Code — implementer
Claude should:
- read `AGENTS.md` and `PR_SPEC.md` first
- implement only the scoped task
- keep changes narrow
- run required checks
- summarize what changed and what remains risky

### Codex — auditor
Codex should:
- read `AGENTS.md` and `PR_SPEC.md`
- inspect the branch or PR
- run validation commands if available
- report correctness, risks, missing coverage, and merge readiness

## Standard operating loop
1. Gemini updates `docs/EXECUTION_BOARD.md`
2. Gemini writes or refreshes `PR_SPEC.md`
3. Claude implements the task on a branch
4. Claude runs checks
5. Codex audits the branch or PR
6. Human reviews and merges
7. Gemini updates:
   - `docs/CURRENT_STATE.md`
   - `docs/EXECUTION_BOARD.md`
   - `docs/DECISIONS.md`
   - next `PR_SPEC.md`

## Definition of done for a task
A task is complete when:
- implementation matches `PR_SPEC.md`
- checks pass
- the PR stays within scope
- risks and follow-ups are documented
- project state docs are updated after merge

## Escalation rule
If a task grows beyond a small PR:
- stop implementation
- split it into smaller tasks
- update `PR_SPEC.md`
- resume only after re-scoping
