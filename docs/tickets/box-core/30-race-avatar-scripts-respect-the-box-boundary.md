# Race avatar scripts respect the Box boundary

Status: DONE

Blocked By: none

Source: noted during ticket 26. `scripts/seed-race-avatars.ts` and `scripts/teardown-race-avatars.ts` (`db:seed:race-avatars`, `db:teardown:race-avatars`) import `RACE_AVATAR_PREFIX` and `raceRoster` from `src/boxes/race/shared-data`. `oxlint.config.ts` ignores `^scripts/`, so `ditzy(no-box-boundary-imports)` never sees them. Ticket 26's acceptance says no file outside a Box's folder imports it; these two do.

## Goal

No file outside `src/boxes/race/` imports Race's code, and the rule that says so covers every file that could break it.

## Decisions

- The avatars belong to the Race Box, so the seeding does too. Options, in order of preference:
  1. Race seeds its own avatars through a Box hook the host already has (for example `setup` defaults or its `routes`), and the two scripts go. Check this first; it may remove the scripts outright.
  2. Move both scripts into `src/boxes/race/` (for example `scripts/seed-avatars.ts`), keep the `package.json` entries pointing there, and keep the seed/teardown pairing AGENTS.md requires.
- Decide whether lint should cover `scripts/` for `ditzy(no-box-boundary-imports)` at least, so the next script can't reintroduce this. If other scripts have a reason to cross the boundary, say which.
- The seed and teardown must keep importing the same data arrays (AGENTS.md, Database seeding and teardown).

## Work

- [x] Choose option 1 or 2 and implement it.
- [x] Make the boundary rule cover wherever these scripts now live.
- [x] Run `bun run db:seed:race-avatars` then `bun run db:teardown:race-avatars` against a scratch database; the teardown removes exactly what the seed added.
- [x] Run `bun run check`.
- [x] Set this ticket to DONE and commit.

## Acceptance

- `git grep -n "boxes/" -- scripts` finds nothing. (Host test files such as `src/server/contract/box-window.test.ts` that import Race on purpose are allowed by the rule and stay.)

## Implementation

Use option 2: there is no startup hook in the Box contract, and seeding local art as a side effect of constructing routes would change startup behavior. The two commands now live as `server-seed-avatars.ts` and `server-teardown-avatars.ts` inside Race. They share the roster/file selection and use database/image operations exported by the server SDK. Optional positional database and avatar-folder arguments allow exercising the real package commands against disposable data.

The boundary rule now checks imports from every non-test file, including tooling. Its previous `src/` gate allowed scripts to import Boxes; the config did not disable this rule for scripts. The newly covered `stream-eyes` server no longer configures an unused Memory embedding selection directly through Box internals; its fake streaming provider stays configured through the host connection module.

Scratch verification seeded two avatars, seeded again without additions, replaced one avatar as a user, and inserted an unrelated library row. Teardown removed only the untouched seeded avatar, preserved both user values, and removed nothing on its second run.

The `stream-eyes` startup smoke initially failed because it seeded before loading Boxes. It now uses the built-in Box loader and `createApp`, which also installs the write observer and serves Box clients. The disposable-server smoke passes. Full validation: `bun run check` passed (129 lint-rule tests, both typechecks, 1,404 unit tests, four E2E harness tests).
