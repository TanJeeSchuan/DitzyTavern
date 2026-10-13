# Boxes are discovered from folders

Status: TODO

Blocked By: 25-box-ids-are-checked-at-runtime

Source: GitHub #72, first tier (operator-installed plugins, no sandbox). The user chose one loader: built-in Boxes are plugins that ship pre-installed.

## Goal

The server builds its Box registry at startup by scanning two folders: the built-in `src/boxes/` and the plugin folder `data/boxes/` (inside the Docker data volume `/app/data`). A plugin folder is laid out exactly like a built-in one. There is one loading path for both.

## Decisions

- Each Box folder holds its own descriptor in `shared-descriptor.ts` (shared layer), exporting the descriptor with its `id`. The central `boxDescriptors` object in `src/shared/contract/box.ts` and the hand-written registration files are removed.
- The descriptor declares `sdk: <major>`. The SDK exports its own major version. A Box built against another major is refused.
- The server imports each folder's descriptor and `server.ts` with `import()`. Bun runs `.ts` directly, so a plugin's server code needs no build step.
- Descriptors are validated with a TypeBox schema at load. An invalid descriptor, an SDK mismatch, a duplicate id or a failing import refuses that Box and logs why. The other Boxes still load. A plugin can't override a built-in.
- Loading happens at startup only. Whether to add hot reload is deferred (open question on #72).
- `GET /api/boxes` lists the loaded Boxes with their ids and each one's client module URL (ticket 27).
- `ditzy(no-box-boundary-imports)` drops its allowlist of registration files. Memory's in-tree UI still reaches Memory through those files: the server registry mounts Memory's routes (`boxRoutes`), and the client registry re-exports Memory's contract and helpers. A Box's routes mount through the generic Box route. Memory's client helpers move into `src/boxes/memory/` and are reached through its client module (ticket 27). Moving the UI itself remains GitHub #24.
- The Dockerfile copies `src/boxes` and `src/box-sdk` (already true) and `docs/docker.md` documents `data/boxes/`.

## Work

- [ ] Move every built-in descriptor into its Box folder, and add `id` and `sdk`.
- [ ] Discover, validate and import Boxes from both folders at startup, refusing bad ones as above.
- [ ] Remove `boxDescriptors`, the static registries' imports and the lint allowlist.
- [ ] Add `GET /api/boxes`.
- [ ] Unit-test refusal: invalid descriptor, SDK mismatch, duplicate id and failing import.
- [ ] Update `docs/box-system/README.md` (folder layout, descriptor, SDK version) and `docs/docker.md`.
- [ ] Run `bun run check` and the full `bun run test:e2e`.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- No file outside a Box's folder imports it, and no file lists Boxes.
- Copying a Box folder into `data/boxes/` and restarting loads it on the server.
