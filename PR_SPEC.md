# PR_SPEC.md
## Title
Add parsing confidence guards for ambiguous bet strings
## Problem
Some ambiguous bet strings can still be auto-structured too aggressively when context is weak or conflicting, which risks bad writes upstream and bad grading downstream.
## Why it matters
Safer parser behavior reduces incorrect stored bets, improves reviewability, and lowers the chance that grading logic acts on low-confidence structured data.
## Scope
- Add additive confidence and ambiguity guards in parsing
- Flag uncertain bet text for manual review instead of high-confidence structuring
- Preserve current parser architecture
- Add focused validation for ambiguous versus clearly parseable cases
- Ensure slip and image parsing does not regress
## Non-goals
- Do not rewrite parser architecture
- Do not re-platform
- Do not redesign grading
- Do not expand into admin command work
- Do not change deploy or runtime architecture
## Likely files touched
- `services/ai.js`
- parser-related helpers if needed
- `tests/*` for focused validation
- docs only if behavior changes
## Required validation
- `npm run check`
- `npm run test:reliability`
## Acceptance criteria
- [ ] Ambiguous bet text is flagged for manual review or low-confidence handling
- [ ] Clearly parseable text still succeeds normally
- [ ] Slip and image parsing behavior does not regress
- [ ] PR stays narrow and reviewable
- [ ] Checks pass
