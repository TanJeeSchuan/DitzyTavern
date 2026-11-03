# Sandboxed Box loader

Status: TODO

Blocked By: 00

Source: `docs/research/sandbox-box-landmark-fit.md` (Verdict, capability set, hook semantics, client projections), `docs/research/deepseek-harness-creator-mode.md`, issue #69 (Capability grants).

## Goal

The registry loads a Box from `descriptor.json`, `logic.js` and `ui.html`, with no build step and no host import. Logic runs in QuickJS, the UI runs in a cross-origin iframe, and the Box can use only capabilities the host binds to its own id. A sandboxed copy of the Tip Jar plugin passes the same `e2e/box-plugin.spec.ts` flow as the trusted Tip Jar, which stays.

## Ownership

- `src/server/box` (registry, the QuickJS adapter, the capability bridge)
- A host route serving the frame document with its CSP
- `src/client/box-windows` (the frame host and its MessagePort bridge)
- `e2e/fixtures/boxes/tip-jar-sandboxed`, `e2e/box-plugin.spec.ts`
- `docs/box-system/README.md`, `docs/docker.md`, a new ADR

## Design decisions already made

- Each sandboxed Box loads under its own id. There is no `sandbox` Box hosting children: lifecycle instance, seed, preset block, traces and schema checks stay per Box.
- QuickJS runs in-process and is called synchronously for sync hooks (`records.initial`/`fold`, `moves.render`, `read`), because capture and window reads call them inside a SQLite read transaction. `advance` uses a Promise bridge, not asyncify.
- Records stay on the server. The frame receives only `read` output.
- No network: the guest has no network globals, and the frame document is served with a CSP that allows no `connect-src`, no forms and images only from the host image route. The iframe is `sandbox="allow-scripts"` with no same-origin, popups or top navigation. Messages are bound to one `MessagePort` per frame instance, not checked by origin.
- Trusted Boxes (`src/boxes`, `data/boxes` with `server.ts`) are unchanged, including trusted plugins on the Docker volume at `/app/data/boxes/<id>/`.
- Both kinds share the plugin folder (`data/boxes/<id>/`, `/app/data/boxes/<id>/` in Docker). What separates them is file kind, not location: the app only ever writes `descriptor.json`, `logic.js` and `ui.html` there, never `server.ts` or `dist/`, and the loader refuses a folder holding both `server.ts` and `logic.js`. Trusted still means "put there by someone with shell or volume access".

## Work

- [ ] Descriptor: `descriptor.json` declares the same fields as `BoxDescriptor` with schemas as JSON Schema. The loader rebuilds TypeBox kinds, keeps Row Reference annotations, and refuses executable fields (Move labels become templates).
- [ ] Adapter: `sandboxedBox(id, descriptor, source)` returns an ordinary `Box` whose hooks call into one QuickJS runtime per Box version, with memory and interrupt limits from ticket 00. `fold` runs the whole batch inside the VM and serializes the result once.
- [ ] Bounds: the host caps the JSON bytes it sends into and accepts out of each hook call and refuses an oversized payload before allocating guest strings, failing the hook with an error naming the Box and hook. Set the cap and the heap and deadline budgets from ticket 00's numbers. A Box whose records grow without limit fails loudly instead of slowing capture.
- [ ] Determinism: the guest gets no `Date.now` or `Math.random`; randomness comes only from the host seed.
- [ ] Errors: guest throws and outcomes cross as a typed JSON envelope that the host maps to its native errors.
- [ ] Registry: discover a folder holding `logic.js` and load it through the adapter. A folder with both `server.ts` and `logic.js` is refused.
- [ ] Frame: the host route serves `ui.html` wrapped with the CSP and a small stylesheet carrying DESIGN.md tokens. The client mounts it in the Box window and bridges `read`, change notifications and `stageMoves(moves)`, which replaces only this Box's composer Moves under the existing schema, count and enabled rules.
- [ ] Add `e2e/fixtures/boxes/tip-jar-sandboxed/`: Tip Jar's behavior as `descriptor.json` + `logic.js` + `ui.html`, with no `box:build`. The trusted `e2e/fixtures/boxes/tip-jar/` stays, so both plugin kinds keep e2e coverage.
- [ ] Run the `e2e/box-plugin.spec.ts` flow against both fixtures, with frame locators for the sandboxed one. Prompt Plan and model request assertions are identical for both.
- [ ] Contract tests: an infinite loop in `fold` and a runaway allocation fail the hook with an error naming the Box; a frame `fetch` is blocked by CSP; a frame message on another port is ignored.
- [ ] Document sandboxed Boxes in `docs/box-system/README.md` and `docs/docker.md` (both kinds on the volume; a sandboxed Box needs no build), and record the decision as an ADR.
- [ ] Run focused tests and lint on changed files; push and let CI run the full suite and e2e.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- Installing the sandboxed Tip Jar needs no build, and its stored records, prompt item and model request match the trusted Tip Jar's.
- A trusted plugin installed by hand, in a checkout or on the Docker volume, loads as it does today.
- Generated code cannot reach the database, another Box's data, host modules or the network.

## Open risks

- Ticket 00 answers whether QuickJS loads under Bun and what limits cost.
