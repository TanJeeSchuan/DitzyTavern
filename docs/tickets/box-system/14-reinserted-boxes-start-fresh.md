# Reinserted Boxes start fresh

Status: TODO

Blocked By: 12-box-authoring-guide, 13-box-lifecycle-per-chat

Source: `docs/box-system/spec.md`, User Story 14 and "Lifecycle per Chat" (inserting a removed Box again starts it from its initial setup); found while writing `docs/box-system/authoring.md`.

## Goal

A writer removes the World Clock from a Chat and inserts it again. The clock starts from its initial setup and shows no time or weather from before the removal, even though the old passages and their records are still in the story.

Today the setup resets, but the old Variant records still fold into state, so the clock comes back with its old minutes and weather. The Race avoids this only because it filters records by `raceId`.

## Ownership

- Per-Chat Box state (instance identity)
- Record writes and the host fold
- `docs/box-system/authoring.md` and `spec.md`, where they describe reinsertion

## Work

- [ ] Each insert gives the Box a new instance id in its per-Chat state. Disable and re-enable keep the instance; remove followed by insert creates a new one.
- [ ] The host stamps every automatic and writer record with the instance that wrote it.
- [ ] The host fold skips records from any other instance. Old records stay stored and visible to inspection, and Variant history is never rewritten.
- [ ] Keep the Race's `raceId`. It separates races within one instance, which is a different thing.
- [ ] Remove the "reinserting keeps old records" caveat from the guide and spec, and describe the instance rule instead.
- [ ] E2E: World Clock digests two passages, is removed and inserted again, and inspection shows its initial time. Re-enabling after a disable still shows the digested time.
- [ ] Run `bun run check` and `bun run test:e2e`.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- No Box needs its own filter to start fresh after reinsertion.
