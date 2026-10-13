# Box UIs load as modules

Status: TODO

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

- [ ] Add the import map and stable host chunks for React and the Box client SDK.
- [ ] Build each built-in Box client as its own externals-sharing entry.
- [ ] Load Box client modules from `GET /api/boxes` and build the client registry from them.
- [ ] Wrap every Box surface in an error boundary and show failed imports in the Box manager.
- [ ] Run `bun run check`, `bun run build` and the full `bun run test:e2e`.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- `src/client` imports nothing from `src/boxes/`.
- A Box whose client throws shows an error in place of its surface, and the rest of the Chat keeps working.
