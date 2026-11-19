# Thermo remediation, round 5

Source: the whole-codebase review of 2026-11-16/17, reviewed at `91184797`. The owner approved every ticket here on 2026-11-17.

Each ticket cites its evidence as a scout report and finding number. The reports are on this machine at `~/Projects/DitzyTavern-eval/answer-key/scout-reports/`, with the verified bug list in `../bugs.md` beside them. Read the cited finding before starting; it carries the `path:line` detail the ticket leaves out.

| Report | File |
|---|---|
| 05 | `05-transcript-and-generation-ui.md` |
| 06 | `06-client-generation-and-conversation-state.md` |
| 11 | `11-generation-workflows-and-compilers-opus.md` |
| 12 | `12-box-system-server-and-built-in-boxes-opus.md` |
| 14 | `14-client-settings-panels-sonnet.md` |
| 17 | `17-server-conversation-domain-opus.md` |
| 18 | `18-http-contract-shared-contract-database-opus.md` |
| 19 | `19-import-characters-box-windows-ui-kit-sonnet.md` |
| 20 | `20-server-imports-libraries-authoring-sonnet.md` |
| 22 | `22-stylesheets-deepseek.md` |
| 23 | `23-test-health-server-core-deepseek.md` |
| 24 | `24-test-health-http-contract-tests-deepseek.md` |
| 25 | `25-test-health-client-and-e2e-specs-deepseek.md` |
| 26 | `26-test-health-remaining-server-and-box-tests-deepseek.md` |

A scout's line numbers were read at `91184797`. Find the code again by name when a line has moved.

## Rules for every ticket

- Read `AGENTS.md`, `CODING_STANDARDS.md` and `GLOSSARY.md` first, and the ADRs the ticket names.
- **One stack.** Every ticket builds on the one before it. T1 branches from master; every later slice branches from the tip of the previous slice's branch. Open one PR per slice, with the previous slice's branch as its base. Never branch from master while an earlier slice is unmerged.
- **Slices.** A ticket with slices a, b, c ships each as its own PR. A slice that would pass about 30 changed files is split again.
- **Behaviour.** A slice changes behaviour only where its ticket says so. Anything else you find is a note in the Outcome, not a change.
- **Bug fixes** start with a test that fails on the base and passes after the fix.
- **Tests that pin internals** are rewritten in the slice that changes those internals. The ticket names them. Keep the guarantee each one carries; the test reports name it.
- **Kept surface.** These stay although nothing in the repository uses them: the Box `upgrade` hook; the commands `rename-participant`, `replace-participant-prompt`, `replace-participant-openings` and the three Character equivalents; the Box SDK exports; `values.chat`. If a change needs one removed, stop and ask.
- **Rejected** approaches listed in a ticket are settled.
- **Checks.** `bun run check` and `bun run test:e2e` run on BuildBuddy or in CI. Never set `LOCAL=1`. Locally, run single test files and typecheck. Wrap any heavy local command in `flock /tmp/ditzy-heavy.lock <cmd>`. Scratch output goes in `.scratch/`, never `/tmp`.
- **Commits.** Stage your own paths by name. Messages describe the change; no ticket ids and no AI attribution trailers.
- **PR body.** Follow `~/.agents/skills/pr/SKILL.md`.
- **Ticket file.** Tick the TODO boxes as you go, set `Status:` to `IN PROGRESS` then `DONE`, and fill in `## Outcome`: what was removed, what was introduced, the commands you ran with their results, and anything left over.

## Order

| Step | Ticket | Slices | First write | Fixes and CI |
|---|---|---|---|---|
| 0 | PR #265 | | merged 2026-11-17 | |
| 1 | [T1 Bugs](t1-bugs.md) | one PR | Sol | Sol |
| 2 | [T2 Deletions](t2-deletions.md) | a, b, c | Sol | Sol |
| 3 | [T3 Stylesheets](t3-stylesheets.md) | one PR | Opus | Opus |
| 4 | [T4 Generation lifecycle](t4-generation-lifecycle.md) | a, b, c, d | Astra for a and b; Sol for c and d | Sol |
| 5 | [T5 Wire](t5-wire.md) | a, b, c, d | Sol | Sol |
| 5b | [T9 Authoring requests and redirects](t9-authoring-fetch.md) | one PR | Sol | Sol |
| 6 | [T6 Generation Settings column](t6-generation-settings-column.md) | one PR | Sol | Sol |
| 7 | [T7 Tests](t7-tests.md) | a, b, c | Sol | Sol |
| 8 | [T8 Client state](t8-client-state.md) | a, b, c, d | Sol for a, b and c; Astra for d | Sol |
| 9 | [T10 Guardrails](t10-guardrails.md) | a, b, c, d | Sol | Sol |

T9 and T10 were added on 2026-11-19 from the round 5 retro; the owner asked for both. Sol means Sol 6.2 from T2 on; T6, T8b and T8c moved off Astra; reviews from T6 on run on Sonnet 5.5 high instead of Opus (owner, 2026-11-19).

## For the orchestrator

- Follow `~/.claude/skills/orchestrate-implementation/SKILL.md`. The owner has approved this plan, so start without asking again.
- One implementer at a time. Dispatch a ticket with slices one slice per implementer run, in order, so the model column above can change between slices.
- Give each implementer the standard prompt plus one line naming its reviewer: Sonnet 5.5 high for a Codex implementer, `codex gpt-6.2-sol high` for a Claude implementer.
- Astra writes the first implementation and stops when its focused checks pass. A Sol delegate in the same checkout then fixes review findings and CI and watches the PR.
- Before a wait on a Codex 429, check quota through the cliproxy management API.
- **Merging.** Merge bottom-up when CI is green and the newest `github-actions` review comment on the head commit raises nothing. Retarget the next PR to master after each merge. Two exceptions wait for the owner: T6, and T8 slice c.
- **T8 slice c** stops after the first write. Report the new state model to the owner and wait before starting fixes.
- **Eval.** After each bug fix in T1 merges, copy its new test file into `~/Projects/DitzyTavern-eval/solutions/` with a one-line note of which bug it covers.
- Stop and ask the owner when a ticket's premise turns out false, when kept surface is in the way, or when a slice cannot stay behaviour-preserving.
