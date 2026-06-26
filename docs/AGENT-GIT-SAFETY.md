# Agent git-safety (shared-checkout protection)

Context: on 2026-06-25, uncommitted edits to services/eventDate.js were wiped twice — once by the
implementing agent's own RED-proof `git checkout -- <file>`, once by a review agent running a
destructive git op in the shared working tree. Both recovered; the rules below prevent recurrence.

## Rules
1. Commit before any destructive git op. Never run `git checkout -- <file>`, `git reset --hard`,
   `git stash`, or `git clean` while holding uncommitted work. Commit first (or stash only AFTER
   committing).
2. RED-proof safely. To show a failing test by reverting code: commit the change first, revert,
   observe RED, then restore with `git checkout <branch> -- <file>`. Or revert a copy made outside
   the tree. Never `git checkout --` a file that has uncommitted edits.
3. Isolate sub-agents. Run review, verification, and RED-proof passes in a SEPARATE worktree
   (`git worktree add ../review-wt <branch>`), never in the implementation checkout.
4. One agent per working tree. No concurrent agents on the same checkout.
5. Clean before launch. `git status` must be clean before launching any sub-agent or destructive op.

## Prompt preamble (paste atop every Code-tab prompt)
Before any `git checkout --`, `git reset`, `git stash`, or `git clean`: COMMIT first — never discard
uncommitted work. RED-proof by committing then reverting (restore via `git checkout <branch> -- <file>`),
or on a copy outside the tree. Run review/RED-proof sub-agents in a separate `git worktree`, never in
this checkout. `git status` must be clean before launching a sub-agent. One agent per checkout.
