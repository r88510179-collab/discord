# AGENTS.md

## Working in this repo (Claude Code / Cowork agents)

- Do only what the task/prompt you were given asks. Do not expand scope, re-platform, or rewrite architecture.
- The repo is the source of truth. Before starting, read the relevant live docs:
  - `docs/CODEMAP.md` — file/line map, schemas, enums (authoritative for code facts).
  - `docs/BACKLOG.md` — current priorities and shipped history.
  - `docs/PREFLIGHT.md` and `docs/DEPLOY_CHECKLIST.md` — operational gates.
  - `docs/SURFACE-PRO.md` — off-Fly service/port map.
- Worktree discipline: confirm `pwd` / `git rev-parse --show-toplevel` and work only inside your assigned worktree. Never write to another checkout by absolute path.
- Verify the live DB schema (`PRAGMA table_info`) before assuming column names. `bets` PK is `id`; `pipeline_events.created_at` is INTEGER epoch seconds.
- Keep PRs narrow and production-safe.
- Run `npm run check` and `npm run test:reliability` before finishing.
- Open a PR and stop. Do not self-merge, do not deploy, do not set secrets, do not mutate the production DB. The maintainer squash-merges and deploys.
- In the PR body, summarize: what changed, what was deliberately not changed, risks, and pasted validation output.
