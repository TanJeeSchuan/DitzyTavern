# Box UIs load as modules

Status: TODO

Blocked By: 26-boxes-are-discovered-from-folders

Source: GitHub #72. Today the SPA is one Vite chunk with React bundled in, and Box UIs are imported statically by `src/client/box-windows/registry.tsx`.

## Goal

The client gets every Box's UI the same way: it reads `GET /api/boxes` and imports each Box's client module. A plugin's client is a prebuilt ESM bundle that shares the host's React and Box SDK. Built-in Boxes take the same path.

## Decisions

- A Box's client module default-exports its client registration (window, dock tab, top bar item, prose lens, Move chip labels, settings) together with its descriptor. Plugins can contribute to every surface that built-ins use.
- An import map in `index.html` maps `react`, `react/jsx-runtime`, `react-dom` and the Box client SDK to host chunks with stable, unhashed filenames. Every Box client bundle treats them as externals.
- Vite builds each built-in Box's client as its own entry with the same externals, so built-ins and plugins resolve identically.
- The server serves plugin client bundles from `data/boxes/<id>/client.js`. Built-ins are served from `dist/`.
- The client imports all loaded Boxes' modules at startup, in parallel, before it renders Box surfaces. A module that fails to import is reported in the Box manager and its surfaces are absent. Every Box surface renders inside an error boundary that names the Box.
- The client registry is a map built from those modules. `registry.tsx`'s static imports go.

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
