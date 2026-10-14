# Race avatar scripts respect the Box boundary

Status: TODO

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

- [ ] Choose option 1 or 2 and implement it.
- [ ] Make the boundary rule cover wherever these scripts now live.
- [ ] Run `bun run db:seed:race-avatars` then `bun run db:teardown:race-avatars` against a scratch database; the teardown removes exactly what the seed added.
- [ ] Run `bun run check`.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- `git grep -n "boxes/race" -- ':!src/boxes/race'` outside `docs/` finds nothing.
