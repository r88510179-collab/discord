# DECISIONS.md

## Decision log

### D-001 — Standardize on Node + Fly + SQLite
- **Status:** Accepted
- **Why:** Avoid split-brain development across older Python/Jarvis and current Node runtime.
- **Effect:** All planning and implementation assume Node.js, Fly.io, Docker, and SQLite.

### D-002 — Use repo-driven multi-agent workflow
- **Status:** Accepted
- **Why:** Planning state should live in the repo, not only inside chats.
- **Effect:** `AGENTS.md`, `CURRENT_STATE.md`, `EXECUTION_BOARD.md`, `DECISIONS.md`, and `PR_SPEC.md` become the baton.

### D-003 — Gemini is planner, Claude is implementer, Codex is auditor
- **Status:** Accepted
- **Why:** Clear role boundaries reduce scope drift and conflicting decisions.
- **Effect:** Gemini writes scopes, Claude codes to scope, Codex audits to scope.

### D-004 — Small PRs over broad rewrites
- **Status:** Accepted
- **Why:** Easier review, safer production changes, better fit for agent workflows.
- **Effect:** Work must be split if it cannot be reviewed comfortably as one PR.

### D-005 — Reliability before feature sprawl
- **Status:** Accepted
- **Why:** The project needed stronger ingestion, grading, and matching safety before expanding features.
- **Effect:** Reliability hardening happened first; future work should be driven by roadmap or real misses.

### D-006 — Use required checks as workflow gate
- **Status:** Accepted
- **Why:** Agents work best with explicit validation targets.
- **Effect:** Every implementation and audit task should run:
  - `npm run check`
  - `npm run test:reliability`
