# Race engine in the prompt

Status: DONE

Blocked By: 04-box-windows-and-dock

Source: `docs/box-system/spec.md`, User Stories 5–6, 23–24, 26, 28, 31; Implementation Decisions "Race Box" (setup, bundled data, slots, engine, Generation intent, record, advance item, Results Stretch); ADR-0050.

## Goal

A writer sets up a race in a minimal Race window: a course, "Fill field" from the bundled roster, Auto mode on. Each Generation then advances one Stretch, and the Prompt Plan tells the narrator what happened in it and to go no further, until a Results Stretch and "Narrate the finish." Swiping keeps the Stretch's outcome. Re-roll draws a new one.

## Ownership

- Race Box engine, setup and records
- Re-roll as a Sibling Generation with a new seed

## Work

- [x] Add bundled data in code: about eight well-known G1 courses (name, distance, surface, direction) and a roster of canon Runners with Running styles. No art.
- [x] Race setup in `conversation_data`: `raceId`, course or custom course, metres per Stretch, slots, Auto mode (`off`, `on`, `until <distance>`), phase.
- [x] "Fill field" draws unused roster Runners with seeded stats biased by Running style.
- [x] Engine: five stats and four Running styles. Phases are opening, middle, final corner and last spurt. Fixed internal steps per Stretch, and Stretches shorten in the final 400 m. Engine AI drives every Runner. It is deterministic for equal state and seed.
- [x] A respond Generation advances one Stretch. A continue Generation advances one only in Auto mode.
- [x] Record `{ raceId, stretch, outcome, after }`. The fold returns `after` for the current `raceId`, and `advance` treats state from another race as initial.
- [x] The advance item gives course and Stretch range, standings, two or three salient events, and "Narrate only this Stretch. Do not go past N m." The Results Stretch gives the finishing order and margins plus "Narrate the finish". After it the Race contributes nothing.
- [x] Add re-roll: a Variant action that starts a Sibling Generation with a new seed.
- [x] Add a minimal Race window for setup, start, New race, and a text standings list. Status shows `🏇 1500m · 3rd` or `🏁 1st · Special Week`.
- [x] Unit tests: engine determinism; the fold across `raceId`s; Stretch shortening.
- [x] E2E: start an Auto mode race, advance two Stretches, swipe (same item), re-roll (different item), finish.
- [x] Run `bun run check` and `bun run test:e2e`.
- [x] Set this ticket to DONE and commit.

## Acceptance

- Selecting an earlier Variant never re-runs later Stretches.
- A finished race contributes nothing until New race.

Validation: `bun run check` passed (1,465 unit tests and 3 harness tests). `bun run test:e2e --workers=1` passed all 45 tests, including the known provider-interruption flake on this final run.

Review decisions: finishing stays in folded Variant state (`state.finished`); setup phase is `setup | running`, so selecting another Variant can restore a running race. Siblings re-resolve the current upstream fold with the inherited seed; unchanged upstream reproduces the same outcome. While running, the dock follows the first gate until Cast slotting in ticket 09; after Results it announces the winner.

Review: Claude Opus 5.5 at high effort reviewed Standards and Spec sequentially, then reviewed the fixes. Both axes passed with no blockers. Final cleanup made capture the sole seed owner, shared the window fold read, and restored strict stored-record decoding.
