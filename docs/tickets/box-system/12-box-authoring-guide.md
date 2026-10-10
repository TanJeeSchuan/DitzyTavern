# Box authoring guide

Status: TODO

Blocked By: 07-race-oval-and-spectator-view, 08-play-a-race-with-moves, 09-cast-members-race-with-their-own-stats, 10-race-drama-and-replay

Source: `docs/box-system/spec.md`, User Story 35, "Pilot order"; ADR-0050.

## Goal

A developer can write a new Box from `docs/box-system/authoring.md` without reading the host.

## Ownership

- `docs/box-system/authoring.md`

## Work

- [ ] Document each hook with what it is for, when the host calls it, and what the host does with its result.
- [ ] Document storage scopes, the namespace rule, and that Boxes cannot add tables.
- [ ] Document history semantics: records are resolved values, folds, swipe and re-roll, Writer overrides, and choosing record granularity.
- [ ] Walk through the Race Box as the worked example.
- [ ] Use the `writing-for-agents` skill so agents can follow the guide.
- [ ] Update the spec wherever implementation diverged.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- Every hook in the contract appears in the guide with a consumer from the pilot.
