# Box UIs load as modules

Status: DONE

Blocked By: 26b-memory-ui-moves-into-its-box

Source: GitHub #72. Today the SPA is one Vite chunk with React bundled in, and Box UIs are imported statically by `src/client/box-windows/registry.tsx`.

## Goal

The client gets every Box's UI the same way: it reads `GET /api/boxes` and imports each Box's client module. A plugin's client is a prebuilt ESM bundle that shares the host's React and Box SDK. Built-in Boxes take the same path.

## Decisions

- A Box's client module default-exports its client registration (primary panel, window, dock tab, top bar item, inspector, settings section, participant section, trace view, prose lens, Move chip labels) together with its descriptor. Plugins can contribute to every surface that built-ins use.
- An import map in `index.html` maps `react`, `react/jsx-runtime`, `react-dom` and the Box client SDK to host chunks with stable, unhashed filenames. Every Box client bundle treats them as externals.
- Vite builds each built-in Box's client as its own entry with the same externals, so built-ins and plugins resolve identically.
- The server serves plugin client bundles from `data/boxes/<id>/client.js`. Built-ins are served from `dist/`.
- The client imports all loaded Boxes' modules at startup, in parallel, before it renders Box surfaces. A module that fails to import is reported in the Box manager and its surfaces are absent. Every Box surface renders inside an error boundary that names the Box.
- The client registry is a map built from those modules. `registry.tsx`'s static imports go, and with them its entry in `ditzy(no-box-boundary-imports)`'s allowlist (the last one, after ticket 26) and its `installBoxDescriptors` list of built-in descriptors.
- Boxes share the host's React Query client. `@tanstack/react-query` joins the import map (or the SDK re-exports what Boxes use), so a Box bundle never carries its own copy: a second copy throws "No QueryClient set". Memory, Phone and Thoughts import it directly today. Box query keys start with the Box id, since the cache is shared (Memory's `["memories", …]` and `["memory-sources", …]` don't yet).
- A Box's CSS (`import "./client.css"`, e.g. Memory's) loads with its client module: the build emits it next to `client.js` and the host links it before rendering the Box's surfaces.
- The error boundary's fallback renders inside the same host frame as the surface it replaces (for an inspector, the host `details-panel` frame from ticket 26b, with its close button).
- `GET /api/boxes` already answers each Box's `client` as `/boxes/<id>/client.js` (ticket 26); serve both built-ins and plugins at that URL, or change it in one place, `src/server/contract/boxes.ts`.

## Work

- [x] Add the import map and stable host chunks for React and the Box client SDK.
- [x] Build each built-in Box client as its own externals-sharing entry.
- [x] Load Box client modules from `GET /api/boxes` and build the client registry from them.
- [x] Wrap every Box surface in an error boundary and show failed imports in the Box manager.
- [x] Run `bun run check`, `bun run build` and the full `bun run test:e2e`.
- [x] Set this ticket to DONE and commit.

## Acceptance

- `src/client` imports nothing from `src/boxes/`.
- A Box whose client throws shows an error in place of its surface, and the rest of the Chat keeps working.

## Notes

- The import map in `index.html` is the one list of host modules: `vite.config.ts` reads it to emit each host chunk (`/host/<name>.js`) and to leave the same specifiers external in every Box build. Besides React, React Query and the two SDK entries, it maps `@sinclair/typebox` and `@sinclair/typebox/value`, so Boxes share the host's TypeBox and its format and kind registries (`numericWire`'s `numeric` format, the descriptor's `BoxSchema` kinds).
- React is CommonJS, so a chunk built straight from it exports only `default`. A package's host chunk re-exports it by name, with the names read from the installed package at build time.
- `vite build` builds every `src/boxes/<id>/client.tsx` alone, in library mode, into `dist/boxes/<id>/client.js`. Every Box now has a `client.tsx` that default-exports its descriptor and surfaces; Mood got one. `digestWindow` takes the descriptor, since a module builds its window before any descriptor is installed.
- Box CSS: rather than the host linking `client.css`, the build prepends a top-level `await` that links it and waits for it to load, so `import()` resolves only once the styles are in. The host and the `/api/boxes` contract need no stylesheet field, and the dev server keeps Vite's own CSS handling.
- `main.tsx` renders after `loadBoxClients()` without a top-level `await`: a Box module imports host chunks that can import the entry chunk, so awaiting in the entry would deadlock that cycle.
- `GET /boxes/<id>/client.js|client.css` serves from `dist/boxes/<id>` for a built-in and the plugin's own folder for a plugin; no other file in a plugin folder is served. Host chunks and Box modules keep their names between builds, so they are served `no-cache`, while hashed assets keep a day's cache.
- `boxWindows` and `boxPanels` are gone; host surfaces read `boxClients()`. Lens `gate` and `strip` run in the host's render, so `LensedProse` catches a throw from either, shows the failure and leaves the prose unlifted. Move chip lists, lifted marks and every component surface render inside `BoxBoundary`.
- The Vite dev server maps `/boxes/<id>/client.js` to `src/boxes/<id>/client.tsx`, or a plugin's `data/boxes/<id>/client.js`.
- Review round 1 (Astra): the client also checks each module against `boxClientSchema` (`src/shared/contract/box-descriptor.ts`), so a malformed registration such as a window without a size is refused at load rather than crashing its host frame, and Box icons render through `BoxIcon`, which bounds them.
- Review round 2 (Astra): a lens's output is checked against its schema inside the lens's guard, so a malformed piece shows the lens's failure beside the unlifted prose instead of crashing the story view.
- Review round 3 (Astra) found nothing at any level.

## Verification

- `bun run check` passed: lint, 133 lint-rule tests, contract ownership, both typechecks, 1,492 unit tests across 172 files and 3 harness tests. The full `bun run test:e2e` then passed 79 of 79, including the new `e2e/box-modules.spec.ts` (a module that fails to import; an inspector that throws).
- After that run, lint warnings in touched files were restructured, `@vite-ignore` joined the comment rule's ignored directives, and a route test was added (`src/server/box/registry.test.ts`, plugin client files only). Then lint, 134 lint-rule tests, the typecheck, `bun run build`, the registry tests (4) and the Box modules, inspector and Memory specs (9) passed.
- Checked by hand in the built app and the Vite dev server: Memory's inspector renders with `/boxes/memory/client.css` linked and its React Query data loaded; failures show in the top bar item, the inspector frame and the Box manager.
- After review round 1's fixes: `bun run check` passed (134 lint-rule tests, 1,493 unit tests, 3 harness tests), then the full `bun run test:e2e` passed 79 of 79.
- After review round 2's fix: `bun run check` passed (134 lint-rule tests, 1,493 unit tests, 3 harness tests), then the full `bun run test:e2e` passed 80 of 80.
