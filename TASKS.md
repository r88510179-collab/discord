# TASKS

## High priority
1. Add automated tests for parser, grading, and database paths.
2. Improve grading for parlays, props, and partial-leg settlement.
3. Add deduplication for picks imported from message channels and Twitter/X.
4. Harden AI parsing with schema validation and better fallbacks.

## Medium priority
5. Replace heuristic team matching with normalized team/player dictionaries.
6. Add explicit migration path from SQLite to Supabase.
7. Add audit logging for auto-graded and AI-parsed actions.
8. Add admin-only commands for reprocessing failed scans and correcting picks.

## Legacy feature ports to evaluate
9. NHL-specific analysis from the older Jarvis notes.
10. ML/training loop concepts from the older Python/Jarvis materials.
11. Approval workflow for high-risk auto-imported picks.
