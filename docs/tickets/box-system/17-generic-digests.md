# Generic digests

Status: DONE

Blocked By: 16-generic-box-host

Source: `docs/box-system/README.md` "Generation lifecycle" step 5 and "The rules" (records); the guide's note that digests, record helpers, catch-up and Decision Model settings are written for the World Clock alone.

## Goal

Any Box that declares `digest` gets the host's digest queue, catch-up, typed record slots, Writer overrides and its own Decision Model selection in settings, with no host edits. The World Clock moves onto this path and behaves exactly as before.

## Ownership

- Host digest queue and catch-up
- Box record slots and Writer override commands
- Per-Box Decision Model selection and its settings UI

## Work

- [x] Make the digest queue iterate every enabled Box that declares `digest`, with the Box's own window and request shape. Remove the World Clock literals from the queue.
- [x] Type record helpers by each Box's declared record schema instead of `WorldClockRecord`.
- [x] Make catch-up start, progress and cancel per Box through the generic Box route from ticket 16.
- [x] Make set and reset of Writer overrides generic over any Box with records.
- [x] A Box that declares a Decision Model need gets its own global selection, stored in `library_data` under its namespace. The settings panel lists one selection per such Box from its descriptor, with no per-Box UI code.
- [x] Derive the `set-box-setup` command's accepted Boxes and setup checks from each Box's declared setup schema, instead of a hand-written union.
- [x] Derive the client-side Move handling in `MoveChips` and `useGenerationController` from the Boxes that declare `moves`, instead of naming them.
- [x] World Clock e2e and unit tests pass unchanged, apart from route paths.
- [x] Run `bun run check` and `bun run test:e2e`.
- [x] Set this ticket to DONE and commit.

## Acceptance

- No host file names the World Clock outside its own Box modules, and no host file lists Boxes by hand for setup or Moves.
- A new digesting Box needs no host edits to get digests, catch-up, Writer overrides and a Decision Model selection.
