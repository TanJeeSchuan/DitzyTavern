# Imports and canvas for sandboxed Boxes

Status: DONE

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
  - The host fetches each one as a single prebundled ES module from esm.sh (`https://esm.sh/<name>@<version>?bundle&target=es2022`). esm.sh answers with a re-export stub (HTTP 200) pointing at a `.bundle.mjs` file, so the host follows same-origin esm.sh module indirections until it reaches a **terminal module with no imports left**, and refuses anything else (probed: three and nanoid end in import-free bundles; `jsonwebtoken` still imports `/node/*.mjs` polyfills, so it is refused). It stores that terminal module in the Box folder as `deps/<name>@<version>.js`, and records its sha256 in `deps.lock.json`. A file already present with a matching hash is used without fetching, so a Box copied in with its `deps/` loads offline, and the e2e fixture never touches the network. esm.sh can only serve code into the sandbox; a bad file cannot escape it.
- **Confined build of the guest's own files.** `Bun.build` with `macros: false` (the default runs guest macros on the host; probed) and one plugin that resolves **and loads** every guest file itself, entrypoints included (`onResolve` + `onLoad`), so Bun never resolves a guest path on its own: a relative import is canonicalized (`realpath`) and must stay inside the Box's source files; a bare specifier must name a declared dependency and maps to its `deps/` file; anything else (absolute paths, `..` escapes, `@/` aliases, Node built-ins, loader attributes such as `with { type: "text" }`) is refused. Build settings come from `Bun.build` options, never from a `tsconfig.json` (probed: a nested guest config could `extends` a file outside the root when Bun resolved files itself). The plugin covers build-time resolutions (static imports, literal `import()` and `require()`, CSS `@import` and `url()`; probed). Computed imports, `import.meta.resolve` and `new URL(…, import.meta.url)` stay in the output and run inside the sandbox, where they reach nothing.
- Output is `logic.bundle.js` and `ui.bundle.js` in the Box folder with the inputs' hash; the loader rebuilds when it differs. Size caps: `ui.bundle.js` 4 MiB, `logic.bundle.js` 1 MiB. Packages that need Node built-ins fail in QuickJS, inside the sandbox.
- Built-in sandboxed Boxes (Race, Mood) don't use this step; ticket 02 bundles them with the repository's normal resolution, since their source is ours.
- **Canvas:** rendered markup may contain `<canvas data-canvas="<name>">`. On `host.canvas(name)` the frame calls `transferControlToOffscreen()` and transfers it to the Worker, then forwards that element's pointer, wheel and key events and its size as plain objects to `host.onCanvasEvent`. Re-rendering markup keeps a transferred canvas element in place.

## Work

- [x] `dependencies` in the descriptor schema with the strict version check.
- [x] Dependency fetch with hash pinning, and the confined build, each failing with an error naming the Box (fetch failure, hash mismatch, refused import, size cap).
- [x] Loader: build on load when needed and run the bundles; single-file Boxes from ticket 01 keep working with no build.
- [x] Canvas bridge in the frame and the Worker prelude (`host.canvas`, `host.onCanvasEvent`).
- [x] Fixture `e2e/fixtures/boxes/dice-3d`: depends on `three` at an exact version and ships its `deps/` file and lock; `logic.js` records a seeded roll from a Move and adds it to the prompt; `ui.js` draws the die with three.js and stages the Move on a canvas click. CI has no GPU, so the spec checks the bundle, the Worker start, the canvas transfer, a forwarded click staging the Move and the Prompt Plan, and accepts a reported "WebGL unavailable"; the WebGL render itself was checked by hand (research note).
- [x] Contract tests: a guest macro, a `../` import, an absolute import, an `@/` alias import and a `with { type: "text" }` import of a host file each fail the build and read nothing outside the Box's sources; every refused specifier form fails the version check; a tampered `deps/` file fails its hash.
- [x] Document dependencies and the canvas bridge in `docs/box-system/sandboxed.md`.
- [x] Run focused tests and lint on changed files; push and let CI run the full suite and e2e.
- [x] Set this ticket to DONE and commit.

## Acceptance

- The dice Box loads from its folder with no network, and a Box without its `deps/` files fetches them once and then loads offline.
- Building a Box never runs its code or its dependencies' code on the host, and never reads a file outside its sources and `deps/`.

## Open risks

- A Box without its `deps/` files needs esm.sh reachable from the server (in Docker, from the container) on first load.
- esm.sh's `?bundle` output for a package can differ from what a local bundler would produce; the hash pins what was fetched, not what npm published.

## Implementation notes

- **Files.** `src/server/box/sandboxed-deps.ts` pins packages (esm.sh fetch, `deps/`, `deps.lock.json`). `src/server/box/sandboxed-build.ts` holds the confined build and the bundle stamp. `sandboxedSources` replaces ticket 01's import refusal in the loader. The descriptor's `dependencies` uses two fixed patterns in `box-sandboxed.ts`.
- **Indirection.** A module with imports is followed only when it is nothing but `export * from "X"` / `export { default } from "X"` lines for one same-origin `X`, which is the stub esm.sh served for three, nanoid and jsonwebtoken (probed 2026-11-04). A bare "single import target" rule would have followed jsonwebtoken's bundle into one of its `/node/*.mjs` polyfills. Fetches use `redirect: "error"` and a 4 MiB cap.
- **Import attributes bypass the plugin.** Probed on Bun 1.4.4: `with { type: "sqlite" }` and `with { type: "macro" }` never reach `onResolve`. The sqlite one builds successfully and leaves a literal `import` in the output, and `macros: false` refuses the macro one. So `onLoad` refuses any guest file whose text holds an import attribute (`with`/`assert` `{ type: …`, static or dynamic), and the build refuses an output that still has a literal import. `text`, `file`, `json`, `toml` and `css` attributes do reach `onResolve`.
- **Containment.** The entry point goes through the same `realpath` check as every relative import, so a `logic.js` symlinked out of the folder is refused too. Packages are served from the source `pinnedPackages` verified, so the build never re-reads `deps/`. `deps/` files and the lock must be regular files (`lstat`). `env: "disable"` is explicit, though Bun 1.4.4 did not inline `process.env` by default either.
- **Contract tests read nothing.** The host targets in `sandboxed-build.test.ts` are regular files holding a module that would build. A first draft used FIFOs, so that a read would hang, but the plugin's `isFile` check refused FIFOs whatever the containment check said, and a mutation dropping containment still passed.
- **Bundle stamp.** The first line of `<part>.bundle.js` is `// inputs <sha256>` over every regular file in the folder except the two bundles. A part with no imports never builds, so ticket 01's single-file Boxes are unchanged.
- **Canvas.** The bridge lives entirely in the frame's host script and the Worker prelude. The app's protocol is unchanged. `host.canvas` reuses the prelude's request/reply path, and the frame answers it itself. Idiomorph keeps a node across renders by id or by soft match on position, so the frame stamps `id="canvas:<name>"` on each `canvas[data-canvas]` to keep a transferred canvas when the surrounding markup changes. Setting a placeholder canvas's `width`/`height` attributes does nothing, so the morph's attribute updates are harmless.
- **Dice fixture.** `logic.js` imports `./roll.js`, so both bundle paths run in e2e; the logic bundle is 0.5 KB and the UI bundle 525 KB. Headless Chromium here reports "WebGL unavailable", and three.js logs the failed context, so the spec allows those two console errors.

### Fix round 1 (Astra review of c09cf60)

- **Links.** `sandboxed-folder.ts` walks a plugin's folder with `lstat` before anything reads it, and refuses a symbolic link, a file with `nlink > 1`, or a non-file anywhere, `deps/`, `deps/@scope/` and the bundles included. It reads every file once into a snapshot. The descriptor, `ui.css`, sources, `deps/`, the lock and the cached bundles all come from it, so the bytes checked, hashed and built are the same. This replaces `realpath` containment: the plugin resolves relative imports by normalizing them against the snapshot's paths, and refuses one into `deps/` (packages are imported by name). The bundles, packages and lock are written by `replaceFile`: an exclusive (`wx`) temporary file renamed over the target, never truncated in place. A concurrent writer on the host is trusted, so there are no no-follow handles.
- **Bundle hash.** The stamp now hashes the Box's own modules (`.js`/`.mjs` outside `deps/`, bundles excluded) and each pinned package by name, so a fetch on first load doesn't force a second rebuild on the next.
- **Fetch.** A response is read through its stream reader and cancelled past the cap. A Box may declare at most 16 packages, holding 8 MiB together and 4 MiB each, shipped or fetched. The count is checked before any fetch, and the remaining budget caps each fetch.
- **Cached bundles** pass the same output checks as fresh ones: the 1/4 MiB cap and no literal imports.
- **Import attributes.** Measured on Bun 1.4.4, static and dynamic forms: only `sqlite` and `macro` skip `onResolve`. `text`, `json`, `toml`, `file`, `css`, `napi` and an unknown type all reach the plugin, which loads the module as JavaScript. A called macro fails with "Macros are disabled". An uncalled one is dropped with a dangling name, and nothing is read or run. `sqlite` leaves a literal import, which the output check refuses. The raw-text regex is gone, and the contract test covers each bypassing form.

