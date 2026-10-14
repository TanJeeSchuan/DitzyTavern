# Box ids are checked at runtime

Status: DONE

Blocked By: 23-memory-leaves-the-host-contract, 24-top-bar-box-items

Source: GitHub #72. A Box installed at runtime can't appear in the `boxIds` const tuple (`src/shared/contract/box.ts`), and today the host's types, routes and command unions are all derived from that tuple.

## Goal

The host treats a Box id as a string checked against the registry. Each Box's payloads (setup, record, Moves) are validated with that Box's own TypeBox schemas where they cross the HTTP or database boundary. Built-in Boxes behave exactly as before.

## Decisions

- `BoxId` becomes `string`. The registries stay maps keyed by Box id, and an unknown id is rejected with 404 (routes) or a command error (actions).
- Remove the `boxIds` tuple and everything derived from it by hand or by type: the `boxId` TypeBox union, `boxIdsWith`, `SetupBoxId`/`RecordBoxId`/`MoveBoxId`/`DigestBoxId`, the per-id `set-box-setup` and `set-box-record` unions in `box-actions.ts`, and the `{ [Id in BoxId]: … }` `satisfies` checks in both registries.
- HTTP bodies carry the Box id and an `unknown` payload. The host asserts the payload against the registered Box's schema before any write.
- Per-Box typing stays inside each Box: its own server, client and shared files keep their static types through the SDK's generic `Box<…>` type.
- Remove the host's remaining Box-name literals (`"author-note"` in `ComposerControls.tsx`, `PrimaryPanelView.tsx`, `workspace/types.ts` and `sillytavern/import-projection.ts`). Where the host needs a Box-specific behavior, the Box declares it.
- Descriptors stay where they are in this ticket. Ticket 26 moves them.

## Work

- [x] Replace the tuple-derived types, unions and route params with string ids checked against the registry.
- [x] Validate setup, record and Move payloads against the registered Box's schemas at the boundary.
- [x] Remove the host's Box-name literals.
- [x] Update `docs/box-system/README.md` and ADR-0050 where they describe the tuple.
- [x] Unit-test that an unknown id and a payload that fails its Box's schema are both rejected.
- [x] Run `bun run check` and the full `bun run test:e2e`.
- [x] Set this ticket to DONE and commit.

## Acceptance

- `rg 'boxIds|BoxId\]' src` finds no tuple or mapped type over Box ids.
- Adding a Box changes no file outside its own folder and its registry entries.
