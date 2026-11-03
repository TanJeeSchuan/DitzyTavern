# Imports and canvas for sandboxed Boxes

Status: TODO

Blocked By: 01 (scheduled after 02b; blocks 03)

Source: `docs/research/sandboxed-box-ui-isolation.md` (Worker probe, three.js render, build-time risks).

## Goal

A plugin sandboxed Box can declare npm `dependencies` and import them from `logic.js` and `ui.js`. The host fetches and bundles them when the Box is loaded, never while it runs, without installing packages or running any of their code on the host. `ui.js` can draw on a canvas, WebGL included, through an `OffscreenCanvas` with forwarded input events. A small 3D dice Box using three.js proves it.

The sandbox, not the code inside it, is the boundary. An imported package is more untrusted code in the same Worker or QuickJS context, so there is no allowlist of packages. The risk this ticket closes is the host **building** untrusted code.

## Ownership

- `src/server/box` (the dependency fetch and the confined build in the loader)
- The frame's host script and the Worker prelude in `src/client/box-windows`
- `e2e/fixtures/boxes/dice-3d`, its spec

## Design decisions already made

- **No package install on the host.** `bun install` of even an exact version can pull transitive Git or tarball dependencies, which invoke SSH with the host's keys, and packages carry `tsconfig` files whose `extends` the bundler follows outside any import hook. So there is no `node_modules`:
  - `descriptor.json` gains `dependencies`: package name to a **strict** `x.y.z` version (regex-checked; ranges, tags, aliases, `file:`, `link:`, `workspace:`, Git and URL specifiers are refused).
  - The host fetches each one as a single prebundled ES module from esm.sh (`https://esm.sh/<name>@<version>?bundle&target=es2022`), stores it in the Box folder as `deps/<name>@<version>.js`, and records its sha256 in `deps.lock.json`. A file already present with a matching hash is used without fetching, so a Box copied in with its `deps/` loads offline, and the e2e fixture never touches the network. esm.sh can only serve code into the sandbox; a bad file cannot escape it.
- **Confined build of the guest's own files.** `Bun.build` with `macros: false` (the default runs guest macros on the host; probed) and one plugin that resolves **every** import itself: a relative import is canonicalized (`realpath`) and must stay inside the Box's source files; a bare specifier must name a declared dependency and maps to its `deps/` file; anything else (absolute paths, `..` escapes, `@/` aliases, Node built-ins, loader attributes such as `with { type: "text" }`) is refused. The build root holds a host-written `tsconfig.json`, so the bundler doesn't walk up to the app's.
- Output is `logic.bundle.js` and `ui.bundle.js` in the Box folder with the inputs' hash; the loader rebuilds when it differs. Size caps: `ui.bundle.js` 4 MiB, `logic.bundle.js` 1 MiB. Packages that need Node built-ins fail in QuickJS, inside the sandbox.
- Built-in sandboxed Boxes (Race, Mood) don't use this step; ticket 02 bundles them with the repository's normal resolution, since their source is ours.
- **Canvas:** rendered markup may contain `<canvas data-canvas="<name>">`. On `host.canvas(name)` the frame calls `transferControlToOffscreen()` and transfers it to the Worker, then forwards that element's pointer, wheel and key events and its size as plain objects to `host.onCanvasEvent`. Re-rendering markup keeps a transferred canvas element in place.

## Work

- [ ] `dependencies` in the descriptor schema with the strict version check.
- [ ] Dependency fetch with hash pinning, and the confined build, each failing with an error naming the Box (fetch failure, hash mismatch, refused import, size cap).
- [ ] Loader: build on load when needed and run the bundles; single-file Boxes from ticket 01 keep working with no build.
- [ ] Canvas bridge in the frame and the Worker prelude (`host.canvas`, `host.onCanvasEvent`).
- [ ] Fixture `e2e/fixtures/boxes/dice-3d`: depends on `three` at an exact version and ships its `deps/` file and lock; `logic.js` records a seeded roll from a Move and adds it to the prompt; `ui.js` draws the die with three.js and stages the Move on a canvas click. CI has no GPU, so the spec checks the bundle, the Worker start, the canvas transfer, a forwarded click staging the Move and the Prompt Plan, and accepts a reported "WebGL unavailable"; the WebGL render itself was checked by hand (research note).
- [ ] Contract tests: a guest macro, a `../` import, an absolute import, an `@/` alias import and a `with { type: "text" }` import of a host file each fail the build and read nothing outside the Box's sources; every refused specifier form fails the version check; a tampered `deps/` file fails its hash.
- [ ] Document dependencies and the canvas bridge in `docs/box-system/README.md`.
- [ ] Run focused tests and lint on changed files; push and let CI run the full suite and e2e.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- The dice Box loads from its folder with no network, and a Box without its `deps/` files fetches them once and then loads offline.
- Building a Box never runs its code or its dependencies' code on the host, and never reads a file outside its sources and `deps/`.

## Open risks

- A Box without its `deps/` files needs esm.sh reachable from the server (in Docker, from the container) on first load.
- esm.sh's `?bundle` output for a package can differ from what a local bundler would produce; the hash pins what was fetched, not what npm published.
