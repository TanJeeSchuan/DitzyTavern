# Sandboxed Box loader

Status: TODO

Blocked By: 00

Source: `docs/research/sandbox-box-landmark-fit.md` (Verdict, capability set, hook semantics, client projections), `docs/research/sandboxed-box-ui-isolation.md` (why the UI runs in a Worker), `docs/research/deepseek-harness-creator-mode.md`, issue #69 (Capability grants).

## Goal

The registry loads a Box from `descriptor.json`, `logic.js` and `ui.js` (plus optional `ui.css`), with no build step and no host import. Logic runs in QuickJS on the server. UI code runs in a Worker inside a sandboxed frame, renders through sanitized markup, and cannot reach the network. The Box can use only capabilities the host binds to its own id. A sandboxed copy of the Tip Jar plugin passes the same `e2e/box-plugin.spec.ts` flow as the trusted Tip Jar, which stays.

## Ownership

- `src/server/box` (registry, the QuickJS adapter, the batched path in `records.ts`)
- `src/server/contract/boxes.ts` (the Box listing carries a sandboxed descriptor)
- A host route serving the frame document with its CSP, and the app page's CSP (`frame-src`)
- `src/client/box-windows` (the frame host, its `MessagePort` bridge and the frame's host script)
- `e2e/fixtures/boxes/tip-jar-sandboxed`, `e2e/box-plugin.spec.ts`
- `docs/box-system/README.md`, `docs/docker.md`, a new ADR

## Design decisions already made

- Each sandboxed Box loads under its own id. There is no `sandbox` Box hosting children: lifecycle instance, seed, preset block, traces and schema checks stay per Box.
- QuickJS runs in-process and is called synchronously for sync hooks (`records.initial`/`fold`, `moves.render`, `read`), because capture and window reads call them inside a SQLite read transaction. `advance` uses a Promise bridge, not asyncify.
- Records stay on the server. The UI receives only `read` output.
- **UI isolation.** Guest UI code never runs in a document. A script in a sandboxed document can always reach the network through WebRTC, and no CSP directive Chromium supports blocks it (`docs/research/sandboxed-box-ui-isolation.md`). So:
  - The frame is `sandbox="allow-scripts"` (opaque origin; no same-origin, popups, forms or top navigation). Its document is served by a host route, without redirects, and runs **only host code**, under a CSP built from `default-src 'none'`: `script-src 'nonce-…' blob:`, `worker-src blob:`, `style-src 'unsafe-inline'` (guest CSS), images only from the host image route, `form-action 'none'`, `frame-ancestors` set to the app origin. No `'unsafe-inline'` in `script-src`.
  - The frame's host script creates a dedicated **Worker from a blob** holding a small host prelude plus the guest's `ui.js`. The Worker inherits the frame's policy and opaque origin: no `RTCPeerConnection`, no DOM, no fetch, socket, import or storage (probed in Chromium and Firefox).
  - The guest renders by sending an HTML string. The frame's host script sanitizes it with DOMPurify (no `script`, `iframe`, `object`, `embed`, `meta`, `link`, `base`, `form`; no event-handler attributes; no `href`, `action`, `formaction`, `xlink:href` or `javascript:`/`data:` URLs; `img src` only on the host image route) and replaces the frame's content with it. Morphing that keeps focus can come later if a Box needs it.
  - Events: the frame's host script delegates `click`, `input`, `change` and `submit` on elements carrying `data-on="<name>"`, and posts `{ name, data: dataset, value, form: values }` to the Worker.
  - The app page gets a CSP whose `frame-src` allows only the host's frame route, as a backstop.
  - Messages between the app and the frame go over one `MessagePort` per frame instance, not checked by origin. The frame relays only structured data between its Worker and the port.
- Guest UI API, provided by the host prelude in the Worker: `host.onRead(fn)`, `host.onEvent(fn)`, `host.render(html)`, `host.stageMoves(moves)`. Nothing else in ticket 01.
- Schemas: `descriptor.json` supports only the TypeBox kinds the Fork walker already handles (`src/server/box/row-references.ts`) plus the primitives and literals they contain. Row Reference annotations are plain properties and are kept as they are. Any other schema form is refused at load. No general JSON Schema support.
- Trusted Boxes (`src/boxes`, `data/boxes` with `server.ts`) are unchanged, including trusted plugins on the Docker volume at `/app/data/boxes/<id>/`.
- Both kinds share the plugin folder (`data/boxes/<id>/`, `/app/data/boxes/<id>/` in Docker). What separates them is file kind, not location: the app only ever writes sandboxed files there (`descriptor.json`, `logic.js`, `ui.js`, `ui.css`, and the bundles from ticket 01b), never `server.ts` or `dist/`, and the loader refuses a folder holding both `server.ts` and `logic.js`. Trusted still means "put there by someone with shell or volume access".
- In ticket 01, `logic.js` and `ui.js` are single files with no imports; an `import` is refused at load. Ticket 01b adds dependencies.

## Work

- [ ] Descriptor: `descriptor.json` declares the same fields as `BoxDescriptor`, with schemas in the supported forms above. Executable fields are refused (Move labels become templates).
- [ ] Adapter: `sandboxedBox(id, descriptor, source)` returns a `Box` whose hooks call into one QuickJS runtime per Box. Hooks that receive no capability share one long-lived context. A hook that receives a capability (`decide` in ticket 02b) runs in a fresh context created for that call and disposed when it settles, so a guest cannot keep a capability in a global for later use.
- [ ] Batched fold: `readBoxFold` (`src/server/box/records.ts:63`) calls `fold` once per record today, so an adapter alone never sees the batch. Give `readBoxFold` a path where a sandboxed Box receives its effective records in Message order in one call, with writer overrides already applied, and returns the folded state once.
- [ ] Limits, starting values: 4 MiB of JSON per hook call in each direction, refused before allocating guest strings; 64 MiB heap per Box runtime; 100 ms of guest execution per entry into the guest, enforced by a clock-based interrupt handler armed at every entry (evaluating `logic.js`, each hook call, each `executePendingJobs` pump), so `async advance() { while (true) {} }` is stopped too. The handler is cooperative and doesn't cover host-side serialization, which the byte cap bounds. Each failure names the Box and hook. Ticket 02 checks them against a compact Race. A Box whose records grow without limit fails loudly instead of slowing capture. In the browser, a runaway `ui.js` only blocks its own Worker; the frame terminates the Worker when the window closes.
- [ ] Determinism: the guest gets no `Date.now` or `Math.random` in `logic.js`; randomness comes only from the host seed. (`ui.js` may use both; it holds no story state.)
- [ ] Errors: guest throws and outcomes cross as a typed JSON envelope that the host maps to its native errors. A Worker error shows in the Box window.
- [ ] Registry: discover a folder holding `logic.js` and load it through the adapter. A folder with both `server.ts` and `logic.js` is refused.
- [ ] Client registration: today `/api/boxes` returns a client module URL and the client imports it for the descriptor and surfaces (`src/server/contract/boxes.ts:20`, `src/client/box-windows/registry.ts:124`). For a sandboxed Box, `/api/boxes` returns its descriptor instead, and the client builds its definition in host code: a window that mounts the frame, and a complete descriptor (TypeBox schemas rebuilt, `moves.label` as a callable built from its template, `moves.max` and `seatBound`, icon and window size), registered through the existing `installBoxes` path. Move chips, validation, seat changes, preset defaults and windows all read these fields.
- [ ] Frame: the host route serves the frame document (host script by nonce, DOMPurify, the token stylesheet carrying DESIGN.md variables). The app sends `ui.js`, `ui.css`, `read` output and change notifications over the port; the frame relays `render` (sanitized, then rendered), events, and `stageMoves(moves)`, which replaces only this Box's composer Moves under the existing schema, count and enabled rules.
- [ ] Add `e2e/fixtures/boxes/tip-jar-sandboxed/`: Tip Jar's behavior as `descriptor.json` + `logic.js` + `ui.js`, with no `box:build`. The trusted `e2e/fixtures/boxes/tip-jar/` stays, so both plugin kinds keep e2e coverage.
- [ ] Run the `e2e/box-plugin.spec.ts` flow against both fixtures, with frame locators for the sandboxed one. Prompt Plan and model request assertions are identical for both.
- [ ] Contract tests (server): an infinite loop in `fold`, a runaway allocation and an oversized payload fail the hook with an error naming the Box; an `async` hook that loops forever before returning is stopped.
- [ ] Isolation e2e: a fixture `ui.js` attempts every escape in the research note's table (fetch, WebSocket, EventSource, importScripts, nested Workers, FontFace, WebTransport, `RTCPeerConnection`) and renders markup that tries `<a href>`, `<img src>` on another origin, `<form action>`, inline handlers, `javascript:` URLs, `<meta http-equiv="refresh">` and CSS `url()`. The test server records zero requests from it, and clicking every rendered element navigates nothing. A message posted to the frame on another port is ignored.
- [ ] Document sandboxed Boxes in `docs/box-system/README.md` and `docs/docker.md` (both kinds on the volume; a sandboxed Box needs no build), and record the decision as an ADR.
- [ ] Run focused tests and lint on changed files; push and let CI run the full suite and e2e.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- Installing the sandboxed Tip Jar needs no build, and its stored records, prompt item and model request match the trusted Tip Jar's.
- A trusted plugin installed by hand, in a checkout or on the Docker volume, loads as it does today.
- Generated code cannot reach the database, another Box's data, host modules or the network.

## Open risks

- [Ticket 00 measured](../../research/sandboxed-box-spike.md) normal QuickJS loading under Bun 1.4.4, reusable contexts after memory/interrupt errors, synchronous SQLite calls and overlapping Promise bridges. Production heap/deadline budgets, host byte limits and bounded job pumping still need implementation; the 200-Stretch batch took about 562 ms with a 512 MiB VM limit.
- Worker isolation was probed in Chromium and Firefox, not Safari.
