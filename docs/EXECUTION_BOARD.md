# EXECUTION_BOARD.md

## NOW
### 1. Parsing confidence guards
- **Outcome:** Ambiguous bet strings are flagged for manual review instead of being auto-structured with high confidence.
- **Owner:** Claude / Codex
- **Size:** Small
- **Dependencies:** Current parser flow, reliability suite
- **Success criteria:** Narrow PR, no parser rewrite, checks pass, focused validation added.

### 2. Project state discipline
- **Outcome:** Planning docs remain current after every merged PR.
- **Owner:** Gemini planning / human
- **Size:** Small
- **Dependencies:** Merge completion
- **Success criteria:** `CURRENT_STATE.md`, `DECISIONS.md`, and this board are updated after each merge.

## NEXT
### 3. Formal SQLite migration runner
- **Outcome:** Schema changes stop depending on ad hoc additive edits in runtime code.
- **Owner:** Gemini planning → Claude → Codex
- **Size:** Medium
- **Dependencies:** Agreement on migration strategy
- **Success criteria:** Minimal migration framework, backward-safe rollout, checks pass.

### 4. Admin correction commands
- **Outcome:** Failed scans and bad picks can be corrected without manual DB edits.
- **Owner:** Gemini planning → Claude → Codex
- **Size:** Small to Medium
- **Dependencies:** Auth/admin guard pattern
- **Success criteria:** Narrow admin-only command set, docs updated if behavior changes.

### 5. Team/player normalization expansion
- **Outcome:** Match reliability improves for high-frequency leagues beyond current heuristic coverage.
- **Owner:** Gemini planning → Claude → Codex
- **Size:** Medium
- **Dependencies:** Current grading/alias layer
- **Success criteria:** Data-driven additions, fixture-based validation, no grading rewrite.

## LATER
### 6. Advanced grading for parlays/props
- **Outcome:** Better settlement accuracy for multi-leg and non-trivial markets.
- **Owner:** Gemini planning → Claude → Codex
- **Size:** Medium to Large
- **Dependencies:** Better normalization, stronger test coverage
- **Success criteria:** Scoped by market type, additive, validated.

### 7. Audit logging / production observability
- **Outcome:** Easier diagnosis of parser and grader decisions in production.
- **Owner:** Gemini planning → Claude → Codex
- **Size:** Medium
- **Dependencies:** Stable event points
- **Success criteria:** Additive logging without noisy or risky refactors.

### 8. Production feedback loop
- **Outcome:** Real-world misses guide future fixes instead of speculative hardening.
- **Owner:** Gemini planning / human
- **Size:** Small
- **Dependencies:** Production usage
- **Success criteria:** Recurring review of misses and next PR selection from observed issues.
