# Box authoring guide

Status: DONE

Blocked By: 07-race-oval-and-spectator-view, 08-play-a-race-with-moves, 09-cast-members-race-with-their-own-stats, 10-race-drama-and-replay, 13-box-lifecycle-per-chat

Source: `docs/box-system/README.md` "Add a Box"; ADR-0050.

## Goal

A developer can write a new Box from `docs/box-system/authoring.md` without reading the host.

## Ownership

- `docs/box-system/authoring.md`

## Work

- [x] Document each hook with what it is for, when the host calls it, and what the host does with its result.
- [x] Document storage scopes, the namespace rule, and that Boxes cannot add tables.
- [x] Document history semantics: records are resolved values, folds, swipe and re-roll, Writer overrides, and choosing record granularity.
- [x] Walk through the Race Box as the worked example.
- [x] Use the `writing-for-agents` skill so agents can follow the guide.
- [x] Update the spec wherever implementation diverged.
- [x] Set this ticket to DONE and commit.

## Acceptance

- Every hook in the contract appears in the guide with a consumer from the pilot.

## Notes

- The host is wired per Box rather than generic, so the guide's "Add a Box" checklist names every file a new Box touches, and each hook section ends with its host wiring.
- Spec changes where the code diverged: the contract block (type parameters, `dependencies` instead of `seed`/`intent`, `moves.render(move, author)`, `DigestContext`, no `id`/`data`/`lens`/`window` on the server Box, `BlockItem` without images); `ctx` reads no data scopes; trace consumed only by Memory; record slot shapes and the seed key; capture gating and the Memory exception; Generation intent for Siblings; preview fingerprint; digest skip and discard rules; Remove scope, `stoppedBox` and records folding after reinsertion; chip labels for disabled Boxes; dock tabs and Phone unread; Race phase without `finished`, stat persistence, record slot, Hold and withdrawal records; Phone advance with no contacts; lens gating.
- Review: `gpt-6-astra` high via `delegate_task` over three rounds. Round 1 found ten inaccurate or incomplete claims, round 2 found four, all fixed; round 3 reported no blocking findings.
