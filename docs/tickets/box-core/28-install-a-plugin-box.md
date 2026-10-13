# Install a plugin Box

Status: DONE

Blocked By: 27-box-uis-load-as-modules

Source: GitHub #72, done when a Box can be installed into a running DitzyTavern image without rebuilding it.

## Goal

A plugin author can build a Box outside this repository, drop it into `data/boxes/<id>/`, restart, and use it. An e2e test proves this with a fixture plugin.

## Decisions

- `bun run box:build <folder>` builds a plugin's `client.js` with the host externals from ticket 27. The server and shared files ship as `.ts`.
- The fixture plugin lives in `e2e/fixtures/boxes/<id>/`. It is a small Box that uses the window, a Move and a record, so the test covers server load, client load and persistence. The e2e server copies it into its per-test `data/boxes/`.
- The authoring section of `docs/box-system/README.md` covers building and installing a plugin, the SDK version, and the refusal rules from ticket 26.

## Notes from ticket 26

- A Box file reaches the SDK as `@/box-sdk/<entry>`, which Bun resolves through the nearest ancestor `tsconfig.json`, and packages through the nearest ancestor `node_modules`. `data/boxes/` sits under the app root, in development and in the image, so both resolve there. The e2e server's plugin folder is `join(E2E_ROOT, "boxes")`, and `E2E_ROOT` is under the OS temp directory, where neither resolves. The fixture plugin needs a plugin folder under the repository, or the loader must resolve those specifiers itself.

## Work

- [x] Add `box:build` to `package.json`.
- [x] Add the fixture plugin and an e2e spec that installs it, enables it in a Chat, uses its window and Move, and sees its record after a restart (`llm.restart`).
- [x] Document plugin authoring and installation.
- [x] Run `bun run check`, `bun run build` and the full `bun run test:e2e`.
- [x] Set this ticket to DONE and commit.

## Acceptance

- The fixture plugin works end to end with no file in `src/` naming it.

## Notes

- `scripts/build-box-client.ts` holds the host modules, read from the import map, and `buildBoxClient`. `vite.config.ts` imports both for the host chunks and the built-in Box builds, and `bun run box:build <folder>` runs it on a plugin, so built-ins and plugins share their externals and their stylesheet link.
- A plugin's client builds into `<folder>/dist/`, not beside its sources. Building in place makes Vite's `outDir` its root, which Vite warns can overwrite sources, and it would overwrite a source stylesheet named `client.css`, as Memory's is. The server serves a plugin's `client.js` and `client.css` from `data/boxes/<id>/dist/`, and the Vite dev server maps to it.
- The fixture plugin is `e2e/fixtures/boxes/tip-jar/`: a window that stages a Move, an `advance` that writes a record each Generation, and a `read` that folds them. It imports a stylesheet, so the spec also covers a plugin's `client.css`.
- Each e2e worker's plugin folder is `.scratch/e2e-boxes-*` under the repository, passed to the server as `E2E_BOXES`, so the fixture's `@/box-sdk` imports and packages resolve. The databases stay in the OS temp directory, which is tmpfs on this host; a synchronous write to the repository's disk took about 50 ms. A reset empties the plugin folder and reloads the registry, so an installed plugin never outlives its test; a restarted server loads the folder as it stands.
- Review round 1 (Astra) found one P3: `bun run typecheck` left out `data/boxes/`, so the README's typecheck step passed for a plugin with type errors. `tsconfig.json` now includes `data/boxes`, which also gives an editor the SDK paths there. Nothing at P0–P2.
- A whole-branch review (Astra medium, `feat/box-core...feat/box-plugins`, tickets 24–28) found three issues the per-ticket reviews missed:
  - P1: a plugin whose `routes` threw stopped `createApp` before the server listened, since the contract built routes outside the loader's refusal handling. `loadBoxes` now takes the server's database and builds each Box's routes inside that Box's refusal `try`, so the Box is refused and logged before the registry is published. `src/server/index.ts` opens its database first. The contract still builds the routes again to mount them against the database it serves. Keeping the loader's instances would tie every Box's routes to one handle, but the e2e server reopens its database and unit tests open one per test. The seed, the import CLI and the test preload mount no routes and pass no database.
  - P2: `box:build` split a dynamic import into a chunk the server never serves. The Box client build sets Rolldown's `codeSplitting: false`, for built-ins and plugins alike. The fixture imports `client-drop.ts` dynamically, so `e2e/box-plugin.spec.ts` fails if a chunk is split out again.
  - P2: turning off a Box whose `records.fold` throws left every Generation failing, since capture folded every record Box. `foldRecordStates` now skips a Box that is not enabled. Its only reader is `captureBoxes`, which already ignored those states. The digest timeline, Box reads and the record command fold through their own paths, and state is never stored, so re-enabling folds the kept records again.

## Verification

- `bun run check` passed: lint, 134 lint-rule tests, contract ownership, both typechecks, 1,493 unit tests across 172 files and 3 harness tests. `bun run build` passed. The full `bun run test:e2e` then passed 81 of 81, including `e2e/box-plugin.spec.ts`.
- `box:build` then gained a required folder argument; lint, the typecheck and a rebuild of the fixture passed after it.
- `grep -rniE "tip-jar|tip jar|tipjar|tip_jar" src/` finds nothing.
- After review round 1's fix: with `data/boxes` in `tsconfig.json`, `bun run typecheck` passed without plugins and reported a type error in a probe plugin at `data/boxes/zz-probe/server.ts`, which was then removed.
- After the whole-branch fixes: `bun run check` passed (134 lint-rule tests, 1,494 unit tests, 3 harness tests). `bun run build` passed, and each built-in Box still emits only `client.js`, plus Memory's `client.css`. `box-plugin`, `box-lifecycle`, `world-clock` and `race-moves` passed 16 of 16, including the World Clock's "a re-enabled one keeps its digested time". Both new registry tests fail with their fix reverted. `bun src/server/index.ts`, started in a scratch directory with a plugin whose `routes` throw, logged its refusal and served `/api/boxes` without it.
