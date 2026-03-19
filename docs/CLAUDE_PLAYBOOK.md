# CLAUDE_PLAYBOOK.md

## Purpose
Use Claude Code to implement the scoped PR only.

## Claude setup notes
- Claude Code is terminal-based and supports project-level configuration.
- Keep Claude constrained to the repo and the written spec.
- Prefer project-shared settings in `.claude/settings.json` and keep personal settings out of source control when needed.

## Inputs Claude should read first
- `AGENTS.md`
- `PR_SPEC.md`

## Claude responsibilities
- implement the scoped task only
- keep the PR narrow
- run required checks
- summarize changes and remaining risks

## Standard Claude prompt
Read AGENTS.md and PR_SPEC.md first.

Implement only what is in PR_SPEC.md.
Keep the PR narrow and production-safe.
Do not re-platform or rewrite architecture.

Run:
- `npm run check`
- `npm run test:reliability`

At the end, summarize:
- what changed
- what was not changed
- risks
- validation results
