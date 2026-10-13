# Install a plugin Box

Status: TODO

Blocked By: 27-box-uis-load-as-modules

Source: GitHub #72, done when a Box can be installed into a running DitzyTavern image without rebuilding it.

## Goal

A plugin author can build a Box outside this repository, drop it into `data/boxes/<id>/`, restart, and use it. An e2e test proves this with a fixture plugin.

## Decisions

- `bun run box:build <folder>` builds a plugin's `client.js` with the host externals from ticket 27. The server and shared files ship as `.ts`.
- The fixture plugin lives in `e2e/fixtures/boxes/<id>/`. It is a small Box that uses the window, a Move and a record, so the test covers server load, client load and persistence. The e2e server copies it into its per-test `data/boxes/`.
- The authoring section of `docs/box-system/README.md` covers building and installing a plugin, the SDK version, and the refusal rules from ticket 26.

## Work

- [ ] Add `box:build` to `package.json`.
- [ ] Add the fixture plugin and an e2e spec that installs it, enables it in a Chat, uses its window and Move, and sees its record after a restart (`llm.restart`).
- [ ] Document plugin authoring and installation.
- [ ] Run `bun run check`, `bun run build` and the full `bun run test:e2e`.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- The fixture plugin works end to end with no file in `src/` naming it.
