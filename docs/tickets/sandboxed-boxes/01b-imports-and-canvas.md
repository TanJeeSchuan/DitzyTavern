# Imports and canvas for sandboxed Boxes

Status: TODO

Blocked By: 01

Source: `docs/research/sandboxed-box-ui-isolation.md` (Worker probe, three.js render, install-time bundling risks).

## Goal

A sandboxed Box can declare npm `dependencies` and import them from `logic.js` and `ui.js`. The host resolves and bundles them when the Box is loaded, never while it runs. `ui.js` can draw on a canvas, WebGL included, through an `OffscreenCanvas` with forwarded input events. A small 3D dice Box using three.js proves it.

The sandbox, not the code inside it, is the boundary. An imported package is more untrusted code in the same Worker or QuickJS context, so there is no allowlist of packages. The new risk is the host **building** untrusted code, and this ticket closes that.

## Ownership

- `src/server/box` (the bundling step in the loader)
- The frame's host script and the Worker prelude in `src/client/box-windows`
- `e2e/fixtures/boxes/dice-3d`, its spec

## Design decisions already made

- `descriptor.json` gains `dependencies`: package name to **exact** version. Ranges are refused.
- The build runs in a host-owned folder per Box outside the plugin folder (for example `data/box-builds/<id>/`), so `node_modules` never sits beside Box files. The host writes `package.json` itself from `dependencies` and copies in only the Box's `.js`/`.css` sources. A guest `bunfig.toml`, `.npmrc`, `package.json` or lockfile is never used.
- `bun install --ignore-scripts`, so no package lifecycle script runs on the host.
- `Bun.build` with `macros: false` (the default runs guest macros on the host; probed), no other plugins except a **confinement** plugin that refuses any import resolving outside the build folder, and no text/file loaders reaching outside it. `logic.js` builds for a JS-only target with Node built-ins refused; `ui.js` builds for the browser.
- Output is `logic.bundle.js` and `ui.bundle.js` in the Box's plugin folder, with the build inputs' hash. The loader rebuilds when the hash differs or a bundle is missing, so a Box copied in by hand builds on its first load, and a Box with bundles runs offline. Size caps: `ui.bundle.js` 4 MiB, `logic.bundle.js` 1 MiB.
- Built-in sandboxed Boxes (Race, Mood) bundle at startup through the same step, from the repository's installed packages.
- Canvas: rendered markup may contain `<canvas data-canvas="<name>">`. On `host.canvas(name)` the frame calls `transferControlToOffscreen()` and transfers it to the Worker, and from then on forwards that element's pointer, wheel and key events and its size as plain objects to `host.onCanvasEvent`. Re-rendering markup keeps a transferred canvas element in place.

## Work

- [ ] `dependencies` in the descriptor schema; exact versions only.
- [ ] The build step as above, with clear errors naming the Box (install failure, a refused import, a size cap).
- [ ] Loader: build on load when needed; run the bundles; plain single-file Boxes from ticket 01 keep working without a build.
- [ ] Canvas bridge in the frame and the Worker prelude (`host.canvas`, `host.onCanvasEvent`).
- [ ] Fixture `e2e/fixtures/boxes/dice-3d`: depends on `three` at an exact version; `logic.js` records a seeded roll from a Move and adds it to the prompt; `ui.js` draws the die with three.js and stages the Move on a click on the canvas. The spec must not depend on the live npm registry (serve the package from a local registry or tarball fixture). CI has no GPU, so the spec checks the bundle, the Worker start, the canvas transfer, a forwarded click staging the Move and the Prompt Plan, and accepts a reported "WebGL unavailable"; the WebGL render itself was checked by hand (research note).
- [ ] Contract tests: a guest macro, a lifecycle script, an import of `../` outside the folder and a `with { type: "text" }` import of a host file each fail the build and leave nothing on disk outside the build folder; a version range is refused.
- [ ] Document dependencies and the canvas bridge in `docs/box-system/README.md`.
- [ ] Run focused tests and lint on changed files; push and let CI run the full suite and e2e.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- The dice Box installs from its folder, builds once, then loads offline.
- Building a Box never runs its code or its dependencies' code on the host, and never reads a file outside its build folder.

## Open risks

- Installing a Box with dependencies needs npm registry access from the server (in Docker, from the container) at first load.
