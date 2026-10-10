# Writer overrides and catch-up for the World Clock

Status: TODO

Blocked By: 04-box-windows-and-dock

Source: `docs/box-system/spec.md`, User Stories 8, 21; Implementation Decisions "History semantics", "World Clock Box" (window); ADR-0050.

## Goal

A writer corrects a misread passage ("that was overnight") in the World Clock timeline and later resets it. A writer adding the clock to an existing Chat digests its whole Selected narrative path with one action.

## Ownership

- Writer override commands for Box records
- Digest catch-up runs
- World Clock timeline editing

## Work

- [ ] Add host commands to set and reset a Box record's `writer` value for a Variant. Validate the value against the Box's record schema.
- [ ] Ensure a digest finishing after an override fills only `automatic` and never changes the effective value.
- [ ] In the timeline, edit a passage's elapsed time and weather, mark overridden passages, and offer reset.
- [ ] Add catch-up: queue digests for every selected Variant without a record, show progress in the window, and allow cancellation.
- [ ] E2E: override survives a late digest; reset restores the automatic value; catch-up digests an existing path.
- [ ] Run `bun run check` and `bun run test:e2e`.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- Overriding a passage changes the clock for every later passage and leaves later records untouched.
- The override never changes the passage's prose.
