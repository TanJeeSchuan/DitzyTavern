# Sandboxed Box loader

Status: TODO

Blocked By: 00

Source: `docs/research/sandbox-box-landmark-fit.md` (Verdict, capability set, hook semantics, client projections), `docs/research/deepseek-harness-creator-mode.md`, issue #69 (Capability grants).

## Goal

The registry loads a Box from `descriptor.json`, `logic.js` and `ui.html`, with no build step and no host import. Logic runs in QuickJS, the UI runs in a cross-origin iframe, and the Box can use only capabilities the host binds to its own id. A sandboxed copy of the Tip Jar plugin passes the same `e2e/box-plugin.spec.ts` flow as the trusted Tip Jar, which stays.

## Ownership

- `src/server/box` (registry, the QuickJS adapter, the capability bridge, the batched path in `records.ts`)
- `src/server/contract/boxes.ts` (the Box listing carries a sandboxed descriptor)
- A host route serving the frame document with its CSP, and the app page's CSP (`frame-src`)
- `src/client/box-windows` (the frame host and its MessagePort bridge)
- `e2e/fixtures/boxes/tip-jar-sandboxed`, `e2e/box-plugin.spec.ts`
- `docs/box-system/README.md`, `docs/docker.md`, a new ADR

## Design decisions already made

- Each sandboxed Box loads under its own id. There is no `sandbox` Box hosting children: lifecycle instance, seed, preset block, traces and schema checks stay per Box.
- QuickJS runs in-process and is called synchronously for sync hooks (`records.initial`/`fold`, `moves.render`, `read`), because capture and window reads call them inside a SQLite read transaction. `advance` uses a Promise bridge, not asyncify.
- Records stay on the server. The frame receives only `read` output.
- No network: the guest has no network globals, and the frame document is served with a CSP that allows no `connect-src`, no forms and images only from the host image route. The iframe is `sandbox="allow-scripts"` with no same-origin, popups or top navigation. A frame can still navigate itself (`location = "https://…?data"`), so the app page gets a CSP whose `frame-src` allows only the host's frame route; the browser checks it on every navigation inside the frame, including ones the frame starts. Messages are bound to one `MessagePort` per frame instance, not checked by origin.
- Schemas: `descriptor.json` supports only the TypeBox kinds the Fork walker already handles (`src/server/box/row-references.ts`) plus the primitives and literals they contain. Row Reference annotations are plain properties and are kept as they are. Any other schema form is refused at load. No general JSON Schema support.
- Trusted Boxes (`src/boxes`, `data/boxes` with `server.ts`) are unchanged, including trusted plugins on the Docker volume at `/app/data/boxes/<id>/`.
- Both kinds share the plugin folder (`data/boxes/<id>/`, `/app/data/boxes/<id>/` in Docker). What separates them is file kind, not location: the app only ever writes `descriptor.json`, `logic.js` and `ui.html` there, never `server.ts` or `dist/`, and the loader refuses a folder holding both `server.ts` and `logic.js`. Trusted still means "put there by someone with shell or volume access".

## Work

- [ ] Descriptor: `descriptor.json` declares the same fields as `BoxDescriptor`, with schemas in the supported forms above. Executable fields are refused (Move labels become templates).
- [ ] Adapter: `sandboxedBox(id, descriptor, source)` returns a `Box` whose hooks call into one QuickJS runtime per Box.
- [ ] Batched fold: `readBoxFold` (`src/server/box/records.ts:63`) calls `fold` once per record today, so an adapter alone never sees the batch. Give `readBoxFold` a path where a sandboxed Box receives its effective records in Message order in one call, with writer overrides already applied, and returns the folded state once.
- [ ] Limits, starting values: 4 MiB of JSON per hook call in each direction, refused before allocating guest strings; 64 MiB heap per Box runtime; 100 ms deadline for sync hooks through the interrupt handler. Each failure names the Box and hook. Ticket 02 checks them against a compact Race. A Box whose records grow without limit fails loudly instead of slowing capture.
- [ ] Determinism: the guest gets no `Date.now` or `Math.random`; randomness comes only from the host seed.
- [ ] Errors: guest throws and outcomes cross as a typed JSON envelope that the host maps to its native errors.
- [ ] Registry: discover a folder holding `logic.js` and load it through the adapter. A folder with both `server.ts` and `logic.js` is refused.
- [ ] Client registration: today `/api/boxes` returns a client module URL and the client imports it for the descriptor and surfaces (`src/server/contract/boxes.ts:20`, `src/client/box-windows/registry.ts:124`). For a sandboxed Box, `/api/boxes` returns its descriptor instead, and the client builds its definition in host code: a window that mounts the frame, plus the descriptor's schemas and Move label templates.
- [ ] Frame: the host route serves `ui.html` wrapped with the CSP and a small stylesheet carrying DESIGN.md tokens. The client mounts it in the Box window and bridges `read`, change notifications and `stageMoves(moves)`, which replaces only this Box's composer Moves under the existing schema, count and enabled rules.
- [ ] Add `e2e/fixtures/boxes/tip-jar-sandboxed/`: Tip Jar's behavior as `descriptor.json` + `logic.js` + `ui.html`, with no `box:build`. The trusted `e2e/fixtures/boxes/tip-jar/` stays, so both plugin kinds keep e2e coverage.
- [ ] Run the `e2e/box-plugin.spec.ts` flow against both fixtures, with frame locators for the sandboxed one. Prompt Plan and model request assertions are identical for both.
- [ ] Contract tests: an infinite loop in `fold`, a runaway allocation and an oversized payload fail the hook with an error naming the Box; a frame `fetch` and a frame navigation to another origin are both blocked; a frame message on another port is ignored.
- [ ] Document sandboxed Boxes in `docs/box-system/README.md` and `docs/docker.md` (both kinds on the volume; a sandboxed Box needs no build), and record the decision as an ADR.
- [ ] Run focused tests and lint on changed files; push and let CI run the full suite and e2e.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- Installing the sandboxed Tip Jar needs no build, and its stored records, prompt item and model request match the trusted Tip Jar's.
- A trusted plugin installed by hand, in a checkout or on the Docker volume, loads as it does today.
- Generated code cannot reach the database, another Box's data, host modules or the network.

## Open risks

- Ticket 00 answers whether QuickJS loads under Bun and what limits cost.
