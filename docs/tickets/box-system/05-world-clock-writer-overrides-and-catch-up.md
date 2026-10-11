# Writer overrides and catch-up for the World Clock

Status: DONE

Blocked By: 04-box-windows-and-dock

Source: `docs/box-system/spec.md`, User Stories 8, 21; Implementation Decisions "History semantics", "World Clock Box" (window); ADR-0050.

## Goal

A writer corrects a misread passage ("that was overnight") in the World Clock timeline and later resets it. A writer adding the clock to an existing Chat digests its whole Selected narrative path with one action.

## Ownership

- Writer override commands for Box records
- Digest catch-up runs
- World Clock timeline editing

## Work

- [x] Add host commands to set and reset a Box record's `writer` value for a Variant. Validate the value against the Box's record schema.
- [x] Ensure a digest finishing after an override fills only `automatic` and never changes the effective value.
- [x] In the timeline, edit a passage's elapsed time and weather, mark overridden passages, and offer reset.
- [x] Add catch-up: queue digests for every selected Variant without a record, show progress in the window, and allow cancellation.
- [x] E2E: override survives a late digest; reset restores the automatic value; catch-up digests an existing path.
- [x] Run `bun run check` and `bun run test:e2e`.
- [x] Set this ticket to DONE and commit.

## Acceptance

- Overriding a passage changes the clock for every later passage and leaves later records untouched.
- The override never changes the passage's prose.

## Verification

- `bun test src/server/box/digest.test.ts src/server/contract/box-window.test.ts src/server/box/world-clock.test.ts`: 24 passed. Catch-up progress, cancellation, restart after cancel, live-before-catch-up ordering, the late-digest merge, schema refusal and the stale-automatic read are all covered.
- `bun run test`: 1458 passed, 6 failed. All 6 failures are unfinished ticket-06 work in this same worktree (the Default recipe gained a `box:race` block and a Variant seed is now generated on resolution); none touch the World Clock.
- `bun run test:e2e`: 44/44 passed, including the two new World Clock tests.
- `bun run lint`, `bun run typecheck`: no errors in ticket-05 files. Both currently fail only on unfinished ticket-06 files (`src/server/box/race-engine.ts` and the race schema/state types); `bun run test:e2e:harness`, `bun run lint:rules`, `bun run check:contracts` and `bun run typecheck:tools` pass.
- `bun run check` therefore cannot go green until ticket 06's partial work is finished or reverted; the ticket-05 portions of it were run individually.
- Manual playwright-cli at 1440x900 and 700x900: the passage Editor, the Overridden mark, Reset/recovery and the disabled catch-up button with its Decision Model note render correctly in the narrow full-screen layer.
- Sequential standards and spec reviews by `claude-opus-5-5` at high reasoning. Fixed: the editor no longer discards a draft on conflict while the notice claims it was kept; an unread passage can no longer be overridden to 0 minutes without picking an elapsed bin; the read exposes `digested` computed by the same source-hash predicate catch-up queues on; a live trigger supersedes a running catch-up job instead of being swallowed; cancel releases the running entries so a restarted run queues the aborted Variants; the late-digest e2e now waits on the server read; the cancel unit test awaits worker shutdown instead of sleeping. Declined: replacing the bin midpoint with an explicit per-bin minute value (a redundant declaration that can drift from the draw range).
