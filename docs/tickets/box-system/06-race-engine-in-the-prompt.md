# Race engine in the prompt

Status: TODO

Blocked By: 04-box-windows-and-dock

Source: `docs/box-system/spec.md`, User Stories 5–6, 23–24, 26, 28, 31; Implementation Decisions "Race Box" (setup, bundled data, slots, engine, Generation intent, record, advance item, Results Stretch); ADR-0050.

## Goal

A writer sets up a race in a minimal Race window: a course, "Fill field" from the bundled roster, Auto mode on. Each Generation then advances one Stretch, and the Prompt Plan tells the narrator what happened in it and to go no further, until a Results Stretch and "Narrate the finish." Swiping keeps the Stretch's outcome. Re-roll draws a new one.

## Ownership

- Race Box engine, setup and records
- Re-roll as a Sibling Generation with a new seed

## Work

- [ ] Add bundled data in code: about eight well-known G1 courses (name, distance, surface, direction) and a roster of canon Runners with Running styles. No art.
- [ ] Race setup in `conversation_data`: `raceId`, course or custom course, metres per Stretch, slots, Auto mode (`off`, `on`, `until <distance>`), phase.
- [ ] "Fill field" draws unused roster Runners with seeded stats biased by Running style.
- [ ] Engine: five stats and four Running styles. Phases are opening, middle, final corner and last spurt. Fixed internal steps per Stretch, and Stretches shorten in the final 400 m. Engine AI drives every Runner. It is deterministic for equal state and seed.
- [ ] A respond Generation advances one Stretch. A continue Generation advances one only in Auto mode.
- [ ] Record `{ raceId, stretch, outcome, after }`. The fold returns `after` for the current `raceId`, and `advance` treats state from another race as initial.
- [ ] The advance item gives course and Stretch range, standings, two or three salient events, and "Narrate only this Stretch. Do not go past N m." The Results Stretch gives the finishing order and margins plus "Narrate the finish". After it the Race contributes nothing.
- [ ] Add re-roll: a Variant action that starts a Sibling Generation with a new seed.
- [ ] Add a minimal Race window for setup, start, New race, and a text standings list. Status shows `🏇 1500m · 3rd` or `🏁 1st · Special Week`.
- [ ] Unit tests: engine determinism; the fold across `raceId`s; Stretch shortening.
- [ ] E2E: start an Auto mode race, advance two Stretches, swipe (same item), re-roll (different item), finish.
- [ ] Run `bun run check` and `bun run test:e2e`.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- Selecting an earlier Variant never re-runs later Stretches.
- A finished race contributes nothing until New race.
