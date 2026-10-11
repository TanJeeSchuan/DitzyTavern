# Generic Box host

Status: TODO

Blocked By: 14-reinserted-boxes-start-fresh

Source: guide test report (a Thoughts Box took 22 files against a checklist of about 12); `docs/box-system/authoring.md` "Add a Box"; ADR-0050.

## Goal

Adding a Box no longer means wiring it into the host at a fixed set of places. A Box is its id and descriptor, one server module, one client module and its tests. The five existing Boxes behave exactly as before.

## Ownership

- Box registration (shared contract, server registry, client registry)
- Box capture
- Box window reads and routes
- Story lenses
- Test fixtures that list Boxes

## Work

- [ ] Add one `boxDescriptors` entry per Box id in the shared contract: label, default outgoing role, and whether new Chats start with it enabled. Derive `singleUseReferenceLabels` entries, default roles, `defaultBoxIds` and the preset editor's add-block menu from it.
- [ ] Replace the per-Box lines in `captureBoxes` with a loop over enabled Boxes. The host derives setup, folded state and Moves from the hooks a Box declares. A Box that needs more declares `dependencies(read)`.
- [ ] Add an optional server `read` hook for a Box's window data, served by one generic `GET /api/conversations/:id/boxes/:box` route. Move the World Clock, Race and Phone window reads onto it and delete their dedicated routes.
- [ ] Add an optional `remove(ctx)` hook for Chat-scoped data a Box keeps outside `conversation_data` and `participant_data`, called by `setBoxState` on removal. Move Memory's removal cleanup onto it.
- [ ] Generalize the lens: a lens contract with its own gate and its own markup tag, lenses chained in registry order over tagged prose pieces, and the streaming hide-unclosed-tag logic per lens. The Phone becomes one lens among others. The saved patch `.scratch/thoughts-box.patch` contains a working generalization to start from.
- [ ] Derive the hand-written `BoxStates` fixtures and the Default preset block lists in tests from `boxIds` and `boxDescriptors`.
- [ ] Do not generalize digests, records or Writer overrides here; ticket 17 does that.
- [ ] Existing e2e passes unchanged, apart from route paths.
- [ ] Run `bun run check` and `bun run test:e2e`.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- No registry, fixture or route lists Box ids by hand except `boxIds` and `boxDescriptors`.
- Behavior of the Author Note, Memory, World Clock, Race and Phone is unchanged.
