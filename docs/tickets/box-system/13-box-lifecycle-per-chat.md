# Box lifecycle per Chat

Status: DONE

Blocked By: 11-phone

Source: `docs/box-system/spec.md`, User Stories 12–14; Implementation Decisions "Lifecycle per Chat"; ADR-0050.

## Goal

A writer opens the Box manager from the composer's Box launcher, inserts the Phone into this Chat, disables the World Clock for a while and removes the Race. Only enabled Boxes reach the Prompt Plan, run digests, accept Moves and show windows. Disabling keeps a Box's setup. Removing deletes it but leaves the story's history alone.

## Ownership

- Per-Chat Box state and its commands
- Box capture, digest queueing and Move staging gates
- Box manager UI
- World Clock setup (removing its own toggle)

## Work

- [x] Store each Box's per-Chat state as `enabled` under `box:<id>` in `conversation_data`. No row means absent. Add insert, disable and remove host commands.
- [x] Remove deletes the Box's Chat-scoped setup and data. It never touches Variant records or Message Moves.
- [x] A new Chat starts with the Author Note and Memory enabled and every other Box absent. Clear dev data instead of migrating it.
- [x] Gate on the state everywhere a Box acts. Only an enabled Box is captured into the Prompt Plan, queues digests, accepts staged Moves, and shows its window and dock tab. Drop staged Moves for a Box that stops being enabled.
- [x] While a Box is not enabled, render its stored Moves in history from their stored label instead of `moves.render`.
- [x] Remove the World Clock's `enabled` setup field and the Phone's always-on behavior. The lifecycle replaces both.
- [x] Add the Box manager to the composer's Box launcher: every Box with its state, a switch, and Remove with confirmation. Use Radix/shadcn primitives and follow DESIGN.md.
- [x] E2E: insert the Phone and see its markup item in inspection; disable it and see no item and no window; re-enable it with its data kept; remove the Race after a Stretch and see that the history and the old Moves still read the same; a new Chat lists only the Author Note and Memory as enabled.
- [x] Verify the Box manager manually with playwright-cli. No UI tests.
- [x] Run `bun run check` and `bun run test:e2e`.
- [x] Set this ticket to DONE and commit.

## Acceptance

- No Box is exempt from removal, including the Author Note and Memory.
- A disabled Box costs nothing per Generation: no prompt item, no digest, no provider call.
