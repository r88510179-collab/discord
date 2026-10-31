---
name: focused-debug
description: Manual, scoped debugging that keeps logs and broad investigation out of the main conversation.
disable-model-invocation: true
---

For the bug described by $ARGUMENTS:
1. Identify the repository, working tree, authoritative local instructions, and precise symptom.
2. Narrow to the relevant code path. Use context-scout for substantial read-only multi-file searches, not one-file lookups.
3. Limit log ranges and search outputs. Summarize representative error evidence instead of pasting long outputs.
4. State a testable cause before any fix; do not guess from absent evidence.
5. Make only authorized narrow changes; run project-required checks. Never treat this skill as permission to merge, deploy, change credentials, or touch production data.
6. Return a concise diagnosis, changed paths, test results, residual risks, and next step.
