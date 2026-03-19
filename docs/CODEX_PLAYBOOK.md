# CODEX_PLAYBOOK.md

## Purpose
Use Codex to audit the implementation branch or PR.

## Inputs Codex should read first
- `AGENTS.md`
- `PR_SPEC.md`

## Codex responsibilities
- audit correctness against the spec
- inspect regression risk
- call out missing validation
- flag architecture drift
- assess merge readiness

## Standard Codex prompt
Read AGENTS.md and PR_SPEC.md first.

Audit this branch or PR for:
- correctness against PR_SPEC.md
- regression risk
- missing tests or validation
- architecture drift
- docs and config drift
- hidden edge cases

Run the project checks if available.

Report:
- pass or fail
- major issues
- minor issues
- suggested fixes
- merge readiness
