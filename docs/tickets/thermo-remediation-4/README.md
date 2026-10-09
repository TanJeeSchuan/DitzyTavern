# Thermo remediation, round 4

Source: GitHub issue #52 (`gh issue view 52`), "Thermo-nuclear code quality review, round 4", reviewed at `3257675`.
Each ticket names its finding; read that finding in the issue before starting.

## Rules for every ticket

- Read `AGENTS.md`, `CODING_STANDARDS.md` and `GLOSSARY.md` first.
- **Ownership.** Edit only the files the ticket lists, plus tests and direct import-site fixes that the change forces.
  Another agent may be working on a disjoint ticket in this same worktree at the same time.
  A typecheck or test failure in a file you do not own and did not touch is not yours: note it in the ticket, do not fix it.
- **Commits.** Stage only your own paths (`git add <paths>`, never `git add -A` / `git add .`).
  Commit messages start with the ticket id (e.g. `T4: …`). No `Co-Authored-By` or other AI attribution trailers.
- **Rejected approaches** listed in a ticket are settled. Do not re-introduce them.
- No backward-compatibility shims, re-export aliases, or fallbacks for removed names. Migrate every caller.
- No tautological tests and no tests that only pin an architectural shape (see AGENTS.md "Code Standards").
- **Storage is constrained.** Do not create git worktrees, do not run `bun install`, and do not run `bun run test:e2e`
  (the orchestrator runs e2e once at the end). Run single test files while working; before committing run `bun run typecheck`, `bun run lint`, `bun run check:contracts` and `bun run test`.
- Update the ticket as you go: tick the TODO checkboxes, set `Status:` to `IN PROGRESS` then `DONE`,
  and fill in the `## Outcome` section (what was removed/introduced, verification commands with results, residuals).

## Order

| Step | Tickets |
|---|---|
| 1 | T1 ‖ T3 |
| 2 | T2 |
| 3 | T4 ‖ T5 |
| 4 | T6 ‖ T7 |
| 5 | T8 |
| 6 | T9a → T9b → T9c |
| 7 | T10 ‖ T11 |
| 8 | T12 |
