# Box system

A **Box** is a story feature in its own folder, with its own state and a fixed set of optional hooks. It turns its state into prompt items through its own Prompt Preset block. It may also resolve Moves the human attached to a Message, read settled prose in the background, and render a floating window that minimizes to a dock. The host stores, orders and routes Box data and never interprets it. [ADR-0050](../adr/0050-build-story-features-as-boxes.md) records why Boxes exist and which designs were rejected.

## The contract

A Box is its folder, `src/boxes/<id>/` for a built-in or `data/boxes/<id>/` for a plugin, which the server [loads at startup](#loading) and the client [loads as a module](#client-modules). The shapes below are a summary; the types live in `src/shared/contract/box-descriptor.ts`, `src/server/box/contract.ts` and `src/client/box-windows/registry.ts`.

```ts
// 1. Descriptor: the default export of src/boxes/<id>/shared-descriptor.ts
export default {
  id: "<id>",                                        // the folder's name, the `box:<id>` preset reference and data namespace; lowercase words joined by `-`
  sdk: 2,                                            // the Box SDK major it was built against, written as a number
  label: "…",                                        // display name everywhere the host shows the Box
  summary: "…",                                      // one plain sentence saying what the Box does, shown in the Box manager
  role: "system",                                    // the preset block's role until an author changes it
  startsEnabled: false,                              // whether a new Chat starts with the Box enabled
  instructions: "…",                                 // the text a new preset block starts with; "" for none
  alwaysRender: true,                                // optional: render the block even when `advance` returns no items
  block: { description, source },                    // optional: the preset editor's copy for the block, in place of the generic copy
  setup: describeSetup(schema, initial),             // optional: per-Chat configuration
  values: { chat: { key: schema }, participant: { key: schema } }, // optional: schemas for stored values
  record: Type.Object({ … }),                        // optional: one Variant's record, folded into state
  moves: describeMoves(schema, max, label),          // optional: actions on a Human-authored Message; add `seatBound: true` to drop them on a seat change
  decision: { summary, description, off, context },  // optional: digest settled prose; copy for its Decision Model setting
  lens: "<tag>",                                     // optional: the tag its client lens lifts, which no delegate may take
  delegate: { tag, operations, summary, description, off }, // optional: a request written as <tag>…</tag> becomes one batch of operations; see Delegate
} satisfies BoxDescriptor;

// 2. Server Box: the default export of src/boxes/<id>/server.ts
const exampleBox = {
  setupError(setup, previous) { … },                 // a message rejecting a setup the schema accepts
  moves: { render(move, author) { … } },             // a Move as history reads it; required by `moves`
  dependencies(read, setup) { … },                   // inputs beyond setup, state and Moves, from the host's CaptureRead
  records: {                                         // required by `record`
    initial,                                         // state before any record; only with `fold`
    fold(state, record, setup) { … },                // one effective record into state; only with `initial`
    digest: { window: 1, async run(window, ctx) { … } }, // a record from settled prose; required by `decision`
  },
  advance: {
    async run(input, ctx) { … },                     // the Box's live content for a Generation: { items, allowance?, trace?, record? }
    trace: schema,                                   // checks the returned trace
    fingerprint(input) { … },                        // replaces dependencies in the preview fingerprint
  },
  status(setup, state) { … },                        // the Status line; digesting Boxes only
  read({ db, summary, history, setup, state }) { … }, // the window's JSON; non-digesting Boxes only
  importSillyTavernNote(note) { … },                 // the setup a SillyTavern chat's Author's Note imports as
  routes(database) { … },                            // an Elysia app of the Box's own routes, served under /api/boxes/<id>
  upgrade(stored) { … },                             // a stored value its changed schemas reject, rewritten; see Checking stored values
  delegate: { async apply({ setup, state, operations, cast }) { … } }, // one batch into the passage's record; required by `delegate`
} satisfies Box<Setup, Dependencies, Trace, Rec, State, Move>;
export default exampleBox;

// 3. Client module: the default export of src/boxes/<id>/client.tsx, built as client.js
export default { descriptor, icon, Window: { size, Panel, lens }, Status } satisfies BoxClientDefinition;
export default { descriptor, ...digestWindow(descriptor, { icon, size, Panel, describe }), header: true };
export default { descriptor, icon, PrimaryPanel };     // primary panel, as the Author Note uses
export default { descriptor, icon, Inspector: { label, Component }, Settings, ParticipantSection, TraceView };
// `descriptor` is the folder's shared-descriptor.ts default export; every surface is optional.
// `Status` is one short line; `header: true` puts it in the Chat tools, so it needs both `Status` and `Window`.
```

Every server hook is optional, as are the descriptor keys marked optional. The loader checks each "required by" pair and each "only", and refuses a Box that breaks one. It also wraps each hook, so the host checks what the hook returns against the contract below where it returns it. Output that fails throws an error naming the Box, the hook and the failing path, which fails the Generation capture, digest or command that called the hook. `Box`'s type parameters default to `Dependencies = undefined`, `Trace = never`, `Rec = never`, `State = undefined` and `Move = never`, and `State` is a JSON value or `undefined`; `Setup` is `undefined` without a `setup` key, so the Thoughts Box is `satisfies Box<undefined>`.

## The rules

- **State is JSON.** A Box's state is the fold of its records, so it must be a JSON value, or `undefined` at the root, as for Memory, which has no fold. The preview fingerprint serializes it, so a `Map` or `Set` would fingerprint as `{}` while still changing the prompt. The loader checks `records.initial`, and the host checks each state `fold` returns. `dependencies` must be JSON too, unless `advance.fingerprint` replaces them in the fingerprint.
- **Records are resolved values.** State is the fold of each selected Variant's effective record, in Message order, from `records.initial`. Selecting an earlier Variant, editing it or overriding it never re-evaluates, invalidates or drops a later record. A swipe reuses the Moves and seed of the Variant it replaces, and the same setup, state, Moves, seed and other dependencies give the same outcome, so a swipe with nothing else changed rewrites only the prose. A re-roll keeps the Moves and draws a fresh seed, so it can draw a new outcome. See [`records`](#record-and-records).
- **Each Box is absent, enabled or disabled in each Chat.** Only an enabled Box runs, and every Chat surface shows while the Box is present, enabled or disabled. Each insert starts a new instance, and the fold reads only the current instance's records, so a reinserted Box starts fresh. See [Lifecycle per Chat](#lifecycle-per-chat).
- **Box data lives in six storage scopes under the `box:<id>` namespace.** Boxes cannot add tables. Each Box-scoped SDK read and write takes the Box's id and fixes the `box:<id>` namespace from it, so a Box names only an id, never a namespace or table. The host's own per-Box values, the Decision Model selection and the delegate setting, live outside it under `box-decision` and `box-delegate`. See [Storage](#storage).
- **A delegate proposes; the Box decides.** A [delegating Box](#delegate-and-delegateapply)'s agent reads prose anyone can write and may propose any batch its `operations` schema accepts, so `delegate.apply` alone makes operations into state and refuses what is illegal.
- **The host knows a Box only by its id.** The id is a string checked against the loaded Boxes at runtime: a Box route answers an unknown id with 404, and a Box command fails it. The host holds every setup, record and Move as a `BoxValue` and checks it against the Box's own schema wherever it crosses the HTTP or database boundary. Each Box types its own values: its server hooks through `satisfies Box<…>`, and its reads through `boxSetupOf` and `boxMovesOf`.
- **A Box reaches the host only through the SDK.** A file in `src/boxes/<id>/` imports its own folder by relative path, packages, and its layer's entries in `src/box-sdk/` as `@/box-sdk/<entry>`, so the folder loads from `data/boxes/` too. No host file lists Boxes, and elsewhere in `src/` only tests import a Box. The `ditzy/no-box-boundary-imports` lint enforces both directions. See [Folder and SDK](#folder-and-sdk).
- **Boxes compose only through the Prompt Plan.** Every Box advances in parallel and never sees another Box's result from the same Generation.
- **Writer overrides overlay automatic records.** The effective record is `writer ?? automatic`. An override never rewrites prose, a later automatic result never displaces it, and reset removes it.

## Add a Box

The host finds every Box by its folder, so adding a Box edits no host file except an SDK entry that lacks an export. If a Box needs more, the host is missing a generalization: raise it instead of adding a special case. Run heavy commands through `flock /tmp/ditzy-heavy.lock`.

1. **Pick the hooks.** From [the contract](#the-contract), choose the descriptor keys and hooks the Box needs. The descriptor keys decide which server hooks the loader demands. Done when you can name each one.
2. **Create the folder.** Make `src/boxes/<id>/` with files named by layer ([Folder and SDK](#folder-and-sdk)). Schemas go in `contract.ts`, or `shared.ts` for a small Box such as Thoughts. Logic both the server and the client use goes in `shared.ts`. Done when `bun run lint` passes.
3. **Describe it.** Write `shared-descriptor.ts`, default-exporting the descriptor with the folder's name as its `id` and `sdk: 2`, and `server.ts`, default-exporting the Box that `satisfies Box<…>` with the types of your own schemas. The loader checks the Box's hooks against its descriptor's keys and refuses the Box with the reason in the server log, so every server test that reads it fails until they match. Done when `bun run typecheck` and the Box's server tests pass.
4. **Write the client module.** Every Box has a `client.tsx` that default-exports its descriptor, its icon and its client surfaces, such as its window. A digesting Box needs a window for its passage timeline and a `Status` line for the dock; Memory, which keeps its own inspector, has none. A digesting Box with no setup, whose generic record summary reads well, needs nothing else: its client module is `{ descriptor, ...digestWindow(descriptor, { icon, size }) }`. Done when `bun run typecheck` and `bun run build` pass.
5. **Test it.** Write `src/boxes/<id>/<flow>.spec.ts` with one test per user flow, asserting through Prompt Plan inspection. Inserting the Box adds its block to the Chat's preset. Insert it with `insertBox(page, "<label>")` from `e2e/fixtures.ts`. A digesting Box also needs `selectBoxDecisionModel(request, "<id>")` and scripted `llm.decisions(…)`. Digests also read the human's Messages, and the first matching rule wins, so end with a catch-all rule after the passage-specific ones (`src/boxes/world-clock/world-clock.spec.ts`). Add unit tests only for logic that can really fail, such as a parser on malformed markup, determinism for a seed, or a fold. Write no UI component tests and no tests of the contract's shape. Done when `bun run check` and `bun run test:e2e` pass.

## Install a plugin Box

A plugin is a Box folder installed into a running DitzyTavern without rebuilding it. It is written exactly as in [Add a Box](#add-a-box), except that it lives outside `src/boxes/`.

1. **Write it in a checkout.** Make the folder in a DitzyTavern checkout's `data/boxes/<id>/`, which git ignores and `bun run typecheck` includes. Under the checkout, `@/box-sdk/<entry>` resolves through its `tsconfig.json` and packages through its `node_modules`, for the server, the typecheck and the build alike. Set `sdk` to the `boxSdkVersion` the shared SDK exports, today `2`. Done when `bun run typecheck` passes.
2. **Build its client.** Run `bun run box:build data/boxes/<id>`. It builds `client.tsx` into `data/boxes/<id>/dist/client.js` as `bun run build` builds a built-in's ([Client modules](#client-modules)): the host modules stay imports, anything else `client.tsx` imports, such as `lucide-react`, is bundled, and a stylesheet it imports becomes `dist/client.css`. The descriptor, contract, shared and server files ship as `.ts`, which Bun runs directly. Done when `dist/client.js` exists.
3. **Install it.** Copy the folder, `dist/` included, to the plugin folder: `data/boxes/<id>/` beside the app, `/app/data/boxes/<id>/` in [Docker](../docker.md). Restart the server. Done when the Box manager lists it with no `Did not load` line. The server log names a Box it refused and why ([Loading](#loading) lists the rules), and a Box whose client module did not load shows `Did not load: <reason>` in its Box manager row.

`e2e/fixtures/boxes/tip-jar/` is a plugin with a window, a Move and a record. `e2e/box-plugin.spec.ts` installs it: the e2e global setup builds it with `box:build`, `llm.installBox("tip-jar")` copies it into the worker's plugin folder, and `llm.restart` loads it. The worker's plugin folder sits under the repository, in `.scratch/`, so the fixture's imports resolve, and each test starts with it empty.

## Sandboxed Boxes

A sandboxed Box is a plugin whose code reaches nothing but what the host hands it, so a Box someone else wrote, or a model, can be installed without trusting it. [ADR-0053](../adr/0053-run-generated-boxes-in-a-sandbox.md) records why it is built this way. Its folder holds plain files, built by the server itself when they import anything ([Imports](#imports)): install it by copying the folder to the plugin folder, `data/boxes/<id>/` or `/app/data/boxes/<id>/` in [Docker](../docker.md), and restarting. A folder holding both `server.ts` and `logic.js` is refused, so the app only ever writes sandboxed files into a folder it manages. `e2e/fixtures/boxes/tip-jar-sandboxed/` is the Tip Jar as a sandboxed Box, and the [Race](#worked-example-the-race) and [Mood](#built-in-boxes) are built-in ones. A built-in sandboxed Box is our own TypeScript: its folder holds `logic.ts` and `ui.ts` in place of `logic.js` and `ui.js`, and the loader bundles each with `Bun.build` at startup, with the repository's own resolution and packages, so the guest receives the same one-file JavaScript a plugin ships and no build output can go stale. `bun run dev:server` restarts the server when a file under `src/boxes` changes, since `bun --watch` does not see files it only bundles.

| File | Holds |
|---|---|
| `descriptor.json` | the [descriptor](#the-contract)'s fields as JSON, `window: { kind?, icon, size }`, and optional `dependencies` |
| `logic.js` | an ES module default-exporting the hooks |
| `ui.js` | a script run in a Worker; none for a digest window |
| `ui.css` | optional; the frame's guest stylesheet |
| other `.js` and `.mjs` files | modules `logic.js` and `ui.js` import |
| `deps/<name>@<version>.js`, `deps.lock.json` | each declared package as one module, and its sha256; the server writes both when they are missing |
| `logic.bundle.js`, `ui.bundle.js` | written by the server's build; first line `// inputs <sha256>` |

**Descriptor.** Each schema is the JSON a TypeBox schema serializes to: `type: "object"` with `properties`, `required` and `additionalProperties: false`; a record as `type: "object"` with one `patternProperties` key, `^(.*)$` for any string or `ParticipantKey`'s `^(?:[0-9])+$`; `type: "array"` with `items`, `minItems`, `maxItems`; `anyOf`; `const`; and `string` (`minLength`, `maxLength`, and `pattern` only as `ParticipantKey`'s, since the host runs every pattern outside the guest's limits), `integer` and `number` (`minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`), `boolean` and `null`. Any schema may carry `title`, `description` and `rowReference`, so [Row References](#row-references-and-stored-values) work as written. Anything else, and any unknown key, refuses the Box with its path. `moves.label` is a template: each `{key}` reads that field of the Move, as `"Tip {coins}"`, shown as its literal's `title` when the Move schema gives that value one, as the Race's `"{kind} · {runner}"` shows `Overtake · Gold Ship`. `window.icon` is one of `box`, `coins`, `dice`, `drama`, `flag`, `gauge`, `heart`, `map`, `scroll`, `sparkles` and `star`; `window.size` is in rem. `window.kind: "digest"` makes the window the host's [passage timeline](#passage-timeline), built with `digestWindow`, in place of a frame, so the Box has no `ui.js`; a Box declares it exactly when it declares a `decision`.

**Imports.** `logic.js` and `ui.js` may import the Box's own `.js` and `.mjs` files by relative path, and the npm packages `descriptor.json` declares by bare name, `"dependencies": { "three": "0.170.0" }`. Each version is one exact `x.y.z`; a range, tag, alias, or `file:`, `link:`, `workspace:`, Git or URL specifier refuses the Box. A Box declares at most 16 packages, holding at most 8 MiB together and 4 MiB each, shipped or fetched. The server installs nothing. It fetches each package once from `https://esm.sh/<name>@<version>?bundle&target=es2022`, following esm.sh's re-export stub on the same origin to a module with no imports left, and refuses a package that still imports, as one needing `/node/*.mjs` polyfills does; a response is cancelled once it passes the cap. It keeps that module as `deps/<name>@<version>.js` and its sha256 in `deps.lock.json`; a file whose hash matches is used without fetching, so a Box copied with its `deps/` loads offline, and one that does not match refuses the Box. A Box without its `deps/` needs esm.sh reachable from the server, in [Docker](../docker.md) from the container, on its first load. A part with no imports runs as written. One that imports is built at load into `logic.bundle.js`, at most 1 MiB, or `ui.bundle.js`, at most 4 MiB, stamped with the hash of the Box's modules and packages; the next load reuses a bundle whose stamp still matches, and holds it to the same cap. A plugin's folder may come unpacked from an archive, so before reading it the loader walks it and refuses a folder holding a symbolic link, a file with more than one hard link, or anything but plain files and folders, anywhere in it, `deps/` and the bundles included, or a folder past 16 MiB, 256 files and folders, or 8 levels deep, counted as it walks and before it reads the file that passes them. It reads every file once, and checks, hashes and builds those bytes; it writes each bundle, package and lock to a new file renamed over the old one. The build runs no guest code on the host: macros are off, no environment variable is inlined, and a plugin of the server's resolves and loads every module itself from those bytes, so the bundler never reads a path, a `tsconfig.json` or a `package.json`. A relative import must name a `.js` or `.mjs` file of the Box's own outside `deps/`; a bare one must name a declared package exactly; an absolute path, a `..` escape, an `@/` alias, a Node built-in and a subpath of a package fail the build. An import attribute such as `with { type: "text" }` changes nothing, since the plugin loads every module as JavaScript; the two that skip the plugin fail too, a called macro because macros are off and a `sqlite` import because it is left in the bundle, which may hold no import. Both parts build as modules so that import stays visible; a built `ui.js`, which may not export, then runs in the Worker wrapped in a function. A computed `import()`, `import.meta.resolve` or `new URL(…, import.meta.url)` stays in the bundle and reaches nothing from inside the sandbox; a package that needs a Node built-in fails there too. `e2e/fixtures/boxes/dice-3d/` imports three.js and draws through `host.canvas`.

**Logic.** `logic.js` may declare `setupError`, `dependencies`, `moves.render`, `records.initial` with `records.fold`, `records.digest` (`window` and `run`), `advance.run`, `read`, `status` and `delegate.apply`; any other hook refuses the Box. The host checks each hook's output as it checks a trusted Box's. `setupError(setup, previous)` runs inside the setup's command transaction, as a trusted Box's does. `dependencies({ seed, intent, cast }, setup)` gets the capture's seed stream, intent and Cast as `{ id, name }`. `advance.run(input)` gets `{ setup, dependencies, state, moves }` and no context, and may be async, as a digest and `delegate.apply({ setup, state, operations, cast })` may; every other hook returns its value. `descriptor.json` declares `delegate` with its `operations` as JSON Schema, and no `lens`. `status(setup, state)` is a digesting Box's Status line, as [a trusted Box's](#decision-recordsdigest-and-status). The fold is the trusted one, but the host hands it the Selected path's effective records in one call.

`read(input, { snapshot })` gets `{ setup, state, cast, human }`: the Cast as `{ id, name, portrait, character }`, with each Portrait's `{ hash, focalX, focalY }` or `null` and the source Character's `{ id, name }` or `null`, and the human seat's Participant id or `null`. It returns `{ view, status? }`. The host serves the window `{ snapshot, status, view }`, where `snapshot` is the Chat revision the read was taken at, shows `status` as the Box's Status line (its label when it returns none), and hands `view` to `ui.js`. `snapshot(query)` reads the Box's own stored values, as stored strings, inside the read's transaction; it answers a closed set of queries and refuses anything else:

| Query | Answers |
|---|---|
| `{ scope: "participant", key }` | `[{ participantId, value }]` for this Chat's Cast |
| `{ scope: "library", key }` or `{ scope: "library", prefix }` | `[{ key, value, revision }]` |
| `{ scope: "character", key }` | `[{ characterId, revision }]` for the Characters this Chat's Cast was seeded from |

**Digest.** `records.digest.run(window, { decide })` gets the [digest window](#decision-recordsdigest-and-status) a trusted Box gets, and `decide` in place of its context. `decide(state, questions)` asks the Box's own Decision Model selection, which the writer chose in Connection Settings and the guest never names, with the host's request packing and token limits, as `ctx.decide` does. It resolves to the answers as entries, `[[key, answer], …]`, not a `Map`. A digest may call it once; a second call throws `decide may be called once per digest.` When the [digest queue](#digest-queue-and-catch-up) supersedes or drops the job (the Variant's text edited or the Variant removed, the Box disabled or removed, its catch-up run cancelled, or the server stopping), the host aborts the request, the pending `decide` rejects in the guest with `The <id> Box's digest was cancelled.`, a late answer is dropped, and the job writes nothing. However a digest ends, the host aborts its request with it, so an unawaited `decide` never outlives its digest. A guest throw, or a refused answer the guest does not catch, fails the digest with `… threw <name>: <message>`, which lands in the slot's `error` as a trusted Box's does. `decide` is the only way a sandboxed Box reaches a model.

`read` and a digest are the hooks handed a capability. Each read evaluates `logic.js` in a fresh context of its own, disposed when it returns. Each digest evaluates it in a runtime of its own, a fresh module instance on its own 64 MiB memory, dropped whole when the digest settles or is cancelled, so a digest stopped halfway leaves no heap or promise chain behind for the next. A guest that keeps `snapshot` or `decide` in a global has nothing in its next call, in `advance`, or in a digest running beside it. It runs in QuickJS in the server process, called synchronously, in its own WebAssembly memory:

| Limit | Value | When it fails |
|---|---|---|
| heap | 64 MiB per Box, and 64 MiB per running digest | `The <id> Box's <hook> ran out of its 64 MiB heap.` |
| guest time | 100 ms per entry: evaluating `logic.js`, each hook call, each job pump | `… ran past its 100 ms limit.` |
| JSON | 4 MiB per call, each way | `… input is over the 4 MiB limit.` or `… result is over …` |

The deadline is checked while guest bytecode runs, not inside one built-in call or host serialization, which the heap and JSON limits bound. A Box whose records grow without limit fails loudly. `logic.js` has no `Math.random`, no `Date.now` and no `new Date()` without arguments, so equal inputs give equal outcomes. A guest throw fails the hook with `… threw <name>: <message>`. `advance.run`, or a digest with no `decide` request in flight, that never settles fails with `… never settled.`

**UI.** The window opens its frame with `POST /api/conversations/:id/boxes/<id>/frame`, naming the version its frame runs, which must be the version the Chat pins; it returns a token the server binds to this Box, this Chat, the Box's insertion instance there and that version, and mounts a `sandbox="allow-scripts"` frame whose document, served at `/api/box-frame/<token>`, runs only host code. Its host script starts `ui.js` in a Worker after a prelude that defines `host`:

| `host.` | Does |
|---|---|
| `onRead(fn)` | calls `fn(view, { moves, disabled, stale, snapshot })` with each window read's view, this Box's staged Moves (`null` while it is not enabled), whether its controls are off, whether the read is from an earlier revision while the current one loads, and the read's snapshot |
| `onEvent(fn)` | calls `fn({ type, name, data, value, files? })` for each `click`, `input` and `change` on an element carrying `data-on="<name>"`: its data attributes and its value, or a checkbox's checked state; a file input's change carries the picked `files` instead |
| `render(html)` | morphs the frame's content into the markup, sanitized, so an element it keeps keeps its focus, caret and typed value, and a CSS transition runs between renders |
| `stageMoves(moves)` | replaces this Box's staged Moves, checked against its Move schema and `max` |
| `commit({ snapshot, expected?, writes?, setup? })` | runs [`commit-box`](#storage) for this Box at that snapshot, refused while controls are off; resolves to `{ outcome: "applied" }`, or `{ outcome: "conflict" \| "refused", reason, current }` with the current read |
| `uploadImage(file)` | stores the image and grants it to this Box; resolves to `{ outcome: "uploaded", hash }` or `{ outcome: "refused", reason }`. One upload runs at a time per frame, and one asked for meanwhile is refused; the server refuses an upload once the Box's granted Images reach 200 or 100 MiB |
| `image(hash)` | the URL of an Image under this frame's image path |
| `setDirty(dirty)`, `onSave(fn)`, `onDiscard(fn)` | joins the window's save guard: the guard asks `fn()` to save, which resolves whether it did (unanswered after 10 s counts as not saved), or tells it to discard |
| `canvas(name)` | transfers the rendered `<canvas data-canvas="<name>">` to the Worker; resolves to its `OffscreenCanvas`, WebGL included, or `null` when the markup holds no such canvas not yet transferred |
| `onCanvasEvent(fn)` | calls `fn(event)` for each event on a transferred canvas, as a plain object with `type` and `canvas`, its name: `pointerdown`, `pointermove`, `pointerup`, `pointercancel`, `pointerenter`, `pointerleave` and `click` with `x`, `y`, `button`, `buttons`, `pointerId`, `pointerType`; `wheel` with `x`, `y`, `deltaX`, `deltaY`, `deltaMode`; `keydown` and `keyup` with `key`, `code`, `repeat`; each with `altKey`, `ctrlKey`, `metaKey`, `shiftKey`; and `resize` with its CSS `width`, `height` and `pixelRatio`, once on transfer and on each change |

The Worker has no DOM and no network: the frame's policy refuses every request but its own image path, `RTCPeerConnection` is absent, and markup loses scripts, frames, forms, links, `meta`, `base`, event handlers and `data:` or `javascript:` URLs. An image displays only when the host says the Box owns it: the Box uploaded it through `uploadImage`, which recorded a grant in `box_image_grant`, or it is the Portrait of someone in this Chat's Cast. A hash the Box wrote into its own values grants nothing. The frame's `img-src` admits only `/api/box-frame/<token>/images/`, whose route serves the bytes after that check, and the sanitizer drops any `src`, `srcset` or `poster` outside it, so `img`, `srcset`, CSS backgrounds and `poster` all hold; the app's own image route is never in reach. A grant owns nothing, so the orphan sweep still removes an upload no stored value references. Image answers carry `Cache-Control: no-store`, so each load in a new frame document passes the check again: a Portrait stops showing once its Participant leaves. The app closes the token when it tears the frame down, on closing the window or switching Chats, and a token stops answering once its Box is removed, even after the Box is inserted again, or once the Chat moves to another version. The frame cannot size a canvas it transferred, so the guest sets the `OffscreenCanvas`'s own size from `resize`. A canvas needs `tabindex` to take key events. The frame gives each `canvas[data-canvas]` the id `canvas:<name>`, so the morph keeps a transferred canvas in place across renders, even when the markup around it changes. The frame's stylesheet carries the host's theme tokens and styles plain buttons and inputs as the host's own. A Worker error shows in the window as `<label> failed: <message>`. Closing the window ends the Worker.

## Creator Mode

**Create a Box** in the Box manager opens Creator Mode: the writer picks a coding model from their Chat Completions Connection Profiles and describes a mechanic, and an embedded [libfx](../research/sandboxed-box-spike.md#libfx-backend-and-agent-loop) agent (pinned 0.0.16, Wasm backend) writes a sandboxed Box. `src/server/authoring/` owns it.

- **The agent's tools** are `read_contract` (the agent-facing contract, `src/server/authoring/contract.md`, and the Mood and Race sources), `read_file` (one of the four files as it is on disk, in pieces past libfx's 64 KiB result limit, since a session `box:submit` made starts with no history of writing them), one content-only write per fixed file (`write_descriptor`, `write_logic`, `write_ui`, `write_css`, each capped before it writes) and `run_scenario`. No tool takes a path or an id: the candidate is a host-made folder, `data/authoring/<session>/<id>/`, and the host sets `descriptor.json`'s `id`. Every argument is checked against its schema first.
- **`run_scenario`** loads the candidate through `checkSandboxedFolder`, the loader's own path for a plugin folder, on an adapter of its own, then plays turns of Moves, passages and scripted `decide` answers, and swipes, which keep their turn's seed and Moves. A delegating Box's turn or swipe scripts `delegated`, the batch its agent would apply (a swipe without prose of its own keeps its turn's), checked against the `operations` of the version running the step and reduced by its `delegate.apply` into that Variant's record; prose holding the tag without one, or one without the tag, fails the scenario, so no step calls a model. `read` answers `snapshot` from the scenario's script, never the database. It returns every diagnostic, each turn's prompt items and record, the folded state and `read` or `status`. With `from: { version, turns? }`, `latest` or a hash, the first `turns` turns (every turn and swipe without it) run on that installed version, loaded fresh from `versions/<hash>/`; then the [upgrade check](#versions) runs on the data they left, written into an in-memory database of its own laid out as the app's (`playedRefusals` in `src/server/conversation/box-upgrade.ts`), so a refusal reads exactly as the writer's **Update** would, and ends the scenario. Once it passes, the result's `upgrade.changes` lists each JSON pointer where the candidate's fold of those records differs from the version's own, which the Scenario panel shows as the state after Update, and the remaining turns and swipes run on the candidate. A change is information, not a failure. The app's database is never read or written.
- **Outside the app**, `bun run box:scenario <box folder> <scenario.json>...` runs the same check for a coding agent: it loads the folder with `checkSandboxedFolder`, named for the Box id, plays each scenario through `runScenario`, prints the results as JSON, and exits 0 when all pass, 1 when one fails and 2 on bad arguments. It never installs, reads the app's data, or imports a trusted Box's `server.ts`; a `from` scenario fails there, since a folder outside the app has no installed versions.
- **The round trip** hands a session to a coding agent outside the app, such as Claude Code or Codex, and takes its work back. `/export` in the panel prints the line to run in the app's folder: `bun run box:export <session> <dir>` writes into a new or empty `<dir>` outside the data folder the candidate as a folder named for its Box id, each scenario the session's log saved whole as `scenarios/<n>.json` (identical ones once), and `AGENTS.md`, which `scripts/box-export.ts` builds from `contract.md` and a section on how to check and submit. The agent checks with `box:scenario`, then `bun run box:submit <box folder> [--box <id>] <scenario.json>...` makes a **new** saved session, never writing into an existing one, which a running server may hold open: it copies the folder, read with `sandboxedFolder`, into a candidate whose id is `--box`, a Box installed from Creator Mode (its `latest` names a version folder), whose `from` scenarios then run on its installed versions and whose Install makes its next version, or a new `authored-…` id. It runs each scenario as `run_scenario` does, caching its check, and writes the session's log as the panel's stream would have: a `prompt` line, then per scenario its `scenario-input` and its `tool`, `tool-end` and `scenario` events. It exits 0 when all pass, printing the session id, 1 when one fails, with the session written all the same, and 2 on bad arguments, writing nothing. The writer opens the session from the start screen, picking a coding model, since a submitted session has none yet, and installs it there. Both scripts use `data/` under the folder they run in, as the server does; neither installs.
- **Install** is the writer's action. It creates a [version](#versions) of the Box from the candidate and moves `latest` to it: the candidate's files are copied into a staging folder beside `versions/`, checked there with the same function, hashed and renamed to `versions/<hash>/`, and the running registry makes that version its catalog entry (`installVersion`) without reloading any loaded Box or version; the client then reads the Chats again and registers only what changed, so open windows keep their frames. Only a version a scenario passed on installs: each `run_scenario` caches its result in `data/boxes/<id>/checks/<version>-<scenario hash>.json`, and Install looks up the candidate's exact hash there before it builds anything; the panel's "latest run passed" gate is only a hint. An id a built-in or unversioned Box uses, or an id folder without `versions/` (a trusted plugin, or a sandboxed folder made by hand), refuses Install. Once the Box has a version, Install replays each of the session's saved scenarios, from its log and without its own `from`, on `latest`, as far as `latest` plays it (the Moves of a turn whose digest failed included, as a Send stores them first, and nothing for a scenario whose setup `latest` refuses), and runs the upgrade check on the data each leaves against the candidate. A refusal keeps `latest` where it is and answers `incompatible`, listing each scenario's refusal, and the panel offers **Install as a new Box** or going back to the agent. **Install as a new Box** (`POST /api/authoring/sessions/:session/new-box`) gives the session's candidate a new id, moving its folder and rewriting its descriptor's id, updates `meta.json`, so the session links to the new Box, runs the latest saved scenario again without its `from`, since the new id makes a new version hash, and installs; Chats holding the first Box keep it. This covers only the data those scenarios produce: a Chat holding data no scenario reached is still guarded by the upgrade check its own **Update** runs. Install and **Install as a new Box** are refused while a turn runs, and Installs of one Box id, from any session, run one at a time, each reading `latest` afresh. Writes wait while a scenario or Install holds the candidate, and a cancelled turn drops the work it left waiting.
- **The profile** maps onto libfx's custom provider in `provider.ts`; a setting libfx cannot carry, such as a Responses API or plain HTTP to another host, is refused with its reason. No output limit is sent, so the provider's own default applies. Steps per message start at 40; the writer changes them between turns with `/steps 40`, `/steps 100` or `/steps none`. Each model request, counted as it leaves for the provider, and each tool call counts against it separately. The next one past the limit waits while the panel asks: **Continue** gives the message 20 more steps and the waiting request or call goes on, and **Stop** ends the turn and says why. Closing the panel while paused cancels the turn. The panel's **Console** shows the session as lines in order: the writer's messages and `/` commands (`/install`, `/steps`, `/files`, `/export`, `/stop`), the agent's replies, its reasoning, and one line per tool call that opens to its input, cut at 64 KiB, and its result. `/files` lists the candidate's fixed files from `GET /api/authoring/sessions/:session/files`. Each `run_scenario` that ran is a line that shows the run in the **Scenario** panel, turn by turn: the Moves as history renders them, the scripted prose, the prompt items and the record, then the folded state and the `read` view. A prompt item that an earlier run of the identical scenario gave and this one does not is struck out. Install needs the latest run to pass. Escape stops a running message instead of closing the panel. Code shows only as read-only CodeMirror text, highlighted as JavaScript or JSON. Sessions are saved as files in `data/authoring/<session>/`: `meta.json` (the Box id, coding model once one ran the session, steps, whether it installed its Box, and when it last changed), `checkpoint.bin` (the libfx checkpoint, written after each turn), `log.ndjson` (the writer's messages, every event the panel was streamed, and each scenario's whole input, which the panel's tool event cuts at 64 KiB) and the candidate folder. Closing the panel, or stopping the server, releases the session's agent and keeps its folder; the start screen lists saved sessions, and opening one restores the agent from its checkpoint on the coding model chosen then and replays the log into the Console. `/discard` deletes the folder. Startup removes only folders without a `meta.json`. A session links to the Box it installed by id alone: it lists the Box as installed while a Box with that id is loaded, and the Box manager offers **Open its session** on that Box. Removing either never breaks the other. A revision the agent checks again installs as the Box's next version, and a Chat already holding the Box moves to it only through its own **Update**.

## Row References and stored values

Declare every Chat and Participant value key in `values.chat` or `values.participant`, with a TypeBox schema for its JSON value. The loader rejects invalid schemas; writes to undeclared keys fail. Library and Character values need no declaration. When a Character seeds a Participant, a loaded Box's Character values are copied only if declared for Participants; an unloaded Box's values are all copied, since there is no descriptor to check them against. Host-owned Chat keys such as `setup` are not Box values.

Use `MessageId`, `VariantId`, and `ParticipantId` from `@/box-sdk/shared` wherever setup, Moves, records, traces, or declared values contain those row ids. For Participant-keyed records use `Type.Record(ParticipantKey, valueSchema)`. These schemas mark Row References so a Fork can rewrite them to copied rows. A missing reference fails the Fork with its path; traces retain missing ids. TypeBox retains `ParticipantKey`'s distinctive digit pattern when building the record, so use the SDK schema instead of spelling that pattern yourself.

## Hooks

### `label`, `summary`, `role`, `startsEnabled`, `instructions`, `alwaysRender`, `block`

| Key | The host uses it for |
|---|---|
| `label` | the preset block label, the add-block menu, the Box manager, the window title, the dock button and the Decision Model setting's name |
| `summary` | the Box manager's line for a Box that is not in the Chat yet, and a Box whose client module did not load |
| `role` | the outgoing role of the Box's preset block (`system`, `user` or `assistant`) until an author changes it |
| `startsEnabled` | `defaultBoxIds()`: the Boxes a new Chat starts with |
| `instructions` | the text a new [preset block](#preset-block) starts with, and what its Reset action restores |
| `alwaysRender` | renders the block when `advance` returns no items, for a Box whose instructions are its whole contribution |
| `block` | the preset editor's `{ description, source }` for the block, in place of "Uses the `<label>` Box when it is enabled in this Chat." from "This Chat" |

Put fixed teaching and framing in `instructions` and only live data in `advance`'s items, so an author can rewrite the wording and the Box never repeats it. Instructions are authored preset text: the [Prompt Macro](../../GLOSSARY.md) pass expands them with `{{self}}` as the human-controlled Participant and `{{other}}` as the model-controlled one.

### `setup` and `setupError`

Per-Chat configuration, declared as `describeSetup(schema, initial)` from the shared SDK. The host stores it in `conversation_data` under key `setup`. A Chat with no stored setup reads `initial`. The Chat summary carries every setup in `conversation.boxSetups` as a `BoxValue`. Read your own with `boxSetupOf(conversation, "<id>", schema)` from the shared SDK, which checks it against your schema and types it, as the Race does.

A Panel saves a whole new setup with `{ type: "set-box-setup", box, setup }`. Use `useBoxSetupDraft("<id>", schema, { conversation, disabled, onConversationChange, conflict, valid?, onSaved?, extra? })` from the client SDK, as the Author Note, World Clock and Race do. It holds the draft against the saved setup and its expected revision, and saves with `save(setup?, writes?)`. On a conflict it keeps the draft and loads the current saved setup beside it. It registers the window's SaveGuard; `extra` adds further unsaved work, such as the Race's open stat sheet, that the guard saves or discards with the draft.

The command accepts a Box that is present in the Chat, enabled or disabled, and checks the value against the schema. An absent Box takes no setup, so nothing saved before an insert survives into it. A setup that must land with the Box's own data writes goes in one [`commit-box`](#storage) instead.

`setupError(setup, previous)` rejects a setup the schema accepts but the Box does not. Its message fails the command and shows in the window.

`importSillyTavernNote(note)` returns the setup, a value of the setup schema, that a SillyTavern chat's Author's Note imports as. The host writes it to the new Chat. Only the Author Note declares it.

### `moves` and `moves.render`

Actions the writer attaches to a Human-authored Message, declared as `describeMoves(schema, max, label)` from the shared SDK. `max` bounds the Moves per Message, and `label(move)` is the chip text. The host shows the Box's icon before it, so the label carries no icon or emoji of its own. `seatBound: true` ties staged Moves to the human seat ([Move staging](#move-staging)). The server Box must declare `render(move, author)`.

The host stores each Box's Moves in order in `messages_data` under key `moves`. For the Generation prompt, Lore scanning and Generation-time Memory recall, the Message's text becomes each Move's `render`, one per line, then the prose. Digests, Memory's extraction among them, read the raw prose. While the Box is not enabled, the host uses the Move's chip label instead of `render`, so a removed Box never breaks past Messages. [Move staging](#move-staging) covers the composer.

Validate staged Moves with the same function the Box resolves them with, kept in `shared.ts`. A Move that was legal when staged may fizzle at resolution, and the Box narrates the failure.

### `record` and `records`

`record` is the `Type.Object` schema of one Variant's record. An object, so an absent record is never confused with a record's value. The server Box must declare `records`. `records.initial` and `records.fold` come together: with them, state is the fold of the Box's records; without them, as in Memory, state is `undefined` and the Box reads its records from the slots `CaptureRead` carries. State is never stored: the host folds it whenever it needs it, for Generation capture, the window `read` and `status`.

Records come from two places: `advance` returns one at Generation time (the Race), or `records.digest` reads settled prose later (World Clock, Mood). Any Box with a `record` accepts Writer overrides through `set-box-record` and `reset-box-record`. Only digesting Boxes get an editor for them, in the [passage timeline](#passage-timeline). An override is refused while its Variant is still generating. Digests change records without a Conversation revision, so `set-box-record` names the effective record the writer's draft started from as `expected`, `null` for none, and the host refuses the override when the slot no longer holds it. The timeline's editor captures it as it opens; a refused save keeps the draft and shows the record there now, so saving again overrides that one. Memory's claim corrections send the claims they edited.

Pick the record's granularity by what an upstream change should do to it:

- **Facts about the passage**, when an earlier change should shift the result. The World Clock stores elapsed minutes and weather, so editing an earlier passage's duration moves every later time.
- **The whole resulting state**, when a step is only meaningful from the exact state it ran on. The Race stores the standings and Hidden intents after each turn, and its fold takes them from the last record, so an earlier change never replays later Stretches. A record never copies an earlier one: the Race's adds at most one replay entry, which the fold appends.

### `decision`, `records.digest` and `status`

`decision` makes the Box a digesting Box (a [delegating Box](#delegate-and-delegateapply) is the other kind the queue runs, and a Box is never both): the server Box must declare `records.digest`, and may declare `status` but not `read`. That one key gives the Box the [digest queue and catch-up](#digest-queue-and-catch-up), the [passage timeline](#passage-timeline) as its window read, and a global Decision Model selection in Connection Settings, worded by the four `decision` strings. The host stores the selection (profile, model and state token limit) in `library_data` under its own `box-decision` namespace, keyed by the Box id. Without a selection no digest runs.

`digest.run(window, ctx)` returns one record for one selected passage. `window` is `{ passage, preceding, seed, cast, data }`. `passage` and each `preceding` entry are `{ messageId, speaker, authorId, content }`; `authorId` is the authoring Participant's id, or `null`. `preceding` holds up to `digest.window` selected Messages before the passage, oldest first. `seed` is this Box's stream of the Variant's seed. `cast` is every Participant in the Chat as `{ id, name, removed }`, removed ones included so every author resolves. `data` is the Box's own `box:<id>` `conversation_data` values by key, as stored strings, without the host's `enabled`, `instance` or `setup`. A Box that should not digest a passage, such as one by an author it ignores, returns an empty record. `ctx` is the [context](#context) `advance` gets, with `ctx.database` for reads the window does not carry; its `signal` aborts when the job is superseded or cancelled.

`ctx.decide(state, questions)` asks the Box's own Decision Model selection. The host packs the request and throws if `state` exceeds the selection's token limit. Questions are keyed by name, and the answers come back as a `Map` with the same keys. A `choice` question names its options as `criteria` keys:

```ts
const answers = await ctx.decide({ passage, preceding }, {
  mood: { type: "choice", instructions: { question: "What mood does `passage` leave the scene in?" }, criteria: { calm: "…", tense: "…" } },
});
const answer = answers.get("mood"); // { type: "choice", choice: "tense", … }
```

Throw on an answer outside your options. A thrown error is logged and written to the slot's `error` with the hash of the text it failed on; it leaves the slot's records alone. The host writes the returned record, which must pass the `record` schema, as the slot's `automatic` value with the hash of the digested text.

`status(setup, state)` is the Box's `Status` line, which `digestWindow` supplies through `useBoxStatus`, or `null` to show the label. The host calls it with the state folded over every selected record, the same state Generation capture folds. The host's dock button, header item and Box manager row carry the accessible name `<label>: <status>`, which is how an e2e test finds them.

### `delegate` and `delegate.apply`

`delegate: { tag, operations, summary, description, off }` lets whoever writes the story change the Box by writing a plain-text request in a passage, `<scene>put the lantern on the table</scene>`: the story model in its reply, or the writer in a Message. The server Box must declare `delegate.apply`, a `record` with `records`, `read` with its own window, and `alwaysRender`, so the instructions that teach the tag reach every prompt; it may not declare `decision`, and its `advance` may return items but never a record (`boxHookOutputs` refuses one), so the delegate is the only producer of its automatic record. `src/server/box/delegate.ts` runs the agent and `src/server/box/digest.ts` its job.

- **The tag.** Lowercase words joined by `-`. The loader and Install refuse a tag another loaded Box takes for a delegate or a [lens](#lens), so a Box with a client lens declares its tag as `lens` in its descriptor; the client refuses a module whose `Window.lens.tag` differs from it or from the server's listing, and a trusted module whose `delegate.tag` differs from the server's listing. One parser, `delegateSegments` in `src/shared/delegate-request.ts`, reads it for the server and the story's lens alike: a request is `<tag>…</tag>` with text and no tag of its own inside; a nested, unclosed, stray or empty tag stays prose, as does one inside, or holding, another Box's lens or delegate element (`otherBoxTags`); several requests join in order into one. The host gives every delegating Box a lens for its tag on the client definition it builds or imports, whose mark's line is the request. The prompt keeps the markup.
- **The job.** Once a passage holding the tag settles, the [digest queue](#digest-queue-and-catch-up) runs a delegate job for it under its landing rules. Jobs of one Chat and Box run one at a time in passage order: one waits while another of that Chat and Box runs, a dropped one included until it settles, or while an earlier passage's is queued. The job folds `state` from the selected records strictly before its passage, never its own earlier record or a later one, so a retry cannot apply its request twice, and retrying an earlier passage never re-runs a later one.
- **The agent.** One libfx agent per job (`createFxAgent`, Wasm, `memory()`), on the Box's delegate setting resolved by `resolveLibfxProvider`, the resolution Creator Mode's coding agent uses. Its prompt holds the passage, the request and the state as JSON; past 64 KiB the run fails rather than cut state short. Its one tool, `apply`, takes `{ operations }` checked against `delegateApplyInput(operations)`: an invalid batch goes back to the model as a tool error, the first valid call is the batch, and a second call fails the run. Model requests and tool calls, a call to a tool it does not have included, count against one 10-step cap. The job's abort cancels the turn and its fetches, and the agent is closed when the job ends. A turn that ends without `apply` or without `end_turn` fails. Nothing is written until the turn ends and `delegate.apply` returns; its throw fails the run with its message, and so does a reducer still pending after 10 seconds (`DELEGATE_APPLY_MS`), whose job holds its lane until then. The agent sees the prompt and the schema and nothing else.
- **The setting.** Profile and model, edited in Connection Settings beside the Decision Model settings, stored in `library_data` under the host's `box-delegate` namespace and served at `/api/boxes/<id>/delegate-settings`. No profile means off, and nothing queues. A setting that does not resolve still queues, and each run fails with its reason.
- **The window.** `DelegateNotice`'s read follows the database's changes, and counts as `landed` the passages whose record is the delegate's run on their current text; a delegating Box's `useBoxRead` keys on that count beside the Conversation revision, so a landed record shows without a revision while the window read does not refetch on every change, since a guest commits at the snapshot it read. `DelegateNotice` at the top of the window reads `GET /api/conversations/:id/boxes/<id>/delegate` and says "The delegate failed on Message N: <reason>", N the passage's place on the Selected path, with **Retry**, which posts the passage to the queue's `/digest` route; without a failure, a broken setting says why. Writer overrides work as for any Box with a record.

Once a version declares `delegate`, Install refuses a later one that drops it or renames its tag ([Versions](#versions)). `run_scenario` scripts each step's batch as `delegated` ([Creator Mode](#creator-mode)).

### `advance`

The Box's turn in a Generation: Send, Continuation, Sibling and Prompt Plan preview alike. `run(input, ctx)` gets `input = { setup, dependencies, state, moves }`. `moves` are the ones on the triggering Human-authored Message: the one sent, or the one a Sibling answers. A Continuation has none, and neither does a Sibling of a Message that follows the model's own.

It returns `{ items, allowance?, trace?, record? }`:

- `items` are `{ text, priority, pinned?, literal? }`, with `priority` a finite number. [Admission](#generation-lifecycle) places them in the Box's block after its instructions. A `literal` item skips the Prompt Macro pass; Memory marks recalled claims literal so a stored claim never runs a macro. An empty list leaves the whole block out, instructions included, unless the descriptor declares `alwaysRender`. A Box without `advance` returns an empty list.
- `allowance`, a whole number of tokens, caps the unpinned items'.
- `record` passes the descriptor's `record` and is written to the new Variant as the slot's `automatic` value when the Variant resolves. The record is stamped with the Box's instance at capture. Only a Box with a `record` descriptor returns one.
- `trace` is JSON that passes `advance.trace`; a Box without `advance.trace` returns none, so a Fork can rewrite every stored trace. The host keeps it, unread, in the Generation's Box traces, keyed by `box:<id>`, beside its budget evidence: the allowance, each item's admission (`admitted`, `allowance`, `oversized` or `context-limit`) in the Box's order, and the block's text as budgeted and as sent, which differ once the writer edits the inspected Prompt Plan. The allowance governs only automatic admission: an edited block answers to the plan's context limit alone, since the Writer's explicit choice wins, as with record overrides. Memory's trace view reads Memory's entry.

`fingerprint(input)` replaces `dependencies` in the [preview fingerprint](#generation-lifecycle). Declare it only when the dependencies do not serialize to what should mark a preview stale. Only Memory declares it.

### `dependencies`

Inputs `advance` needs beyond setup, state and Moves. The host calls `dependencies(read, setup)` at capture, inside the read transaction the rest of the Generation's inputs come from, and passes the result as `input.dependencies`; without the hook it is `undefined`. `read` is the `CaptureRead`:

| Field | Value |
|---|---|
| `database`, `conversationId` | further reads, inside the capture's read transaction |
| `seed` | this Box's stream of the Variant's seed |
| `intent` | `"continue"` for a Continuation and for a Sibling whose preceding Message the model wrote; otherwise `"respond"` |
| `human` | the human-controlled Participant's `{ id, name }` |
| `cast` | every Cast member's `{ id, name }` |
| `messages` | the Selected path as the model reads it: `{ messageId, variantId, position, authorId, speaker, role, content, prose, slot }`, where `content` renders the Message's Moves before its prose, `prose` is the stored text and `slot` is the Box's own record slot on the Variant, typed by its `record` |
| `pending` | the text a Send submits, Moves rendered, before it becomes a Message; `undefined` otherwise |

### Context

`advance.run` and `digest.run` receive the same `ctx` in every Box: each service below, and `signal`, which aborts when the server shuts down or, in a digest, when the job is superseded or cancelled. A service throws when called without the configuration it needs, such as `decide` without a selection.

| Service | Does |
|---|---|
| `llm(profileId)` | the chat Connection Profile, or `undefined` once it is gone; its `complete({ model, prompt, contextLimit, responseBudget, signal?, onContent? })` streams one completion with `prompt` as the system message and returns `{ content, finishReason }` |
| `decide(state, questions)` | asks the Box's own [Decision Model selection](#decision-recordsdigest-and-status); it throws without one |
| `embed(texts, configuration, { cache? })` | one vector per text, in one request, from an `EmbeddingConfiguration` the SDK's `readEmbeddingConfiguration(database, profileId, model)` resolves, which is `undefined` when no embedding model is configured; with `cache`, texts embedded before under the same model and credentials are read back from the host's `embedding_cache` |

### `read`

The window's data for a non-digesting Box, served at `GET /api/conversations/:id/boxes/<id>`. The host opens one read transaction, answers a missing Chat with 404, and calls `read({ db, conversationId, summary, history, setup, state })`: `db` for further reads in that transaction, the Chat's `summary`, its Selected path as `history`, the Box's `setup`, and `state`, its fold over the Selected path's effective records, the same fold Generation capture uses, or `undefined` without a fold. Return JSON. Send only what the writer may see: the Race read holds back its replay and Hidden intents until the finish.

Declare the read schema in `contract.ts` or `shared.ts`, and read it on the client with `useBoxRead(conversation, "<id>", schema)` from the client SDK. It keys the query by the Box id, the Chat and its `revision`, so it refetches when the Chat changes and keeps the previous read as placeholder data meanwhile, decodes the read with the schema, and returns `null` for a missing Chat:

```ts
const useThoughts = (conversation: ConversationSummary) => useBoxRead(conversation, "thought", thoughtRead);
```

### `routes`

Routes the Box serves beside the host's, as an Elysia app built from the database. The server builds it once, when it loads the Box, for the database it serves, and mounts it under `/api/boxes/<id>` there. It refuses the Box if building throws, returns anything but an Elysia app, or mounting throws. Its `/settings` is `/api/boxes/<id>/settings`; the host's own `/api/boxes/<id>/decision-settings` and `/api/boxes/<id>/delegate-settings` are there too, so name none of them that. Declare their schemas in `contract.ts` and export the app's type, `export type <Id>Routes = ReturnType<typeof <id>Routes>`. The client calls them with `boxApi<<Id>Routes>("<id>")` from the client SDK, an Eden client rooted at that prefix, as Memory's `client-api.ts` does. Only Memory declares routes; a Box with a window reads through `read` instead.

### Client surfaces

The client registry, `loadedBoxes()` in `src/client/box-windows/registry.ts`, holds each Box the server loaded once, by id, in registry order: its metadata, and its client module or why it did not load. `boxClients()` lists the client modules that loaded. Every surface renders inside a `BoxBoundary` in its host frame: a surface that throws shows `<label> failed: <message>` in its place, and the rest of the Chat keeps working. The host draws a Box's icon with `BoxIcon`, which leaves an alert icon if it throws. Settings and participant sections render for every loaded Box. Every Chat surface (window, dock button, header item, primary panel, inspector and lens, with their launchers and the inspector's message action) shows while the Box is present in the Chat, enabled or disabled, and none shows while it is absent; `boxPresent` in `src/client/box-windows/registry.ts` is that one check. The composer's launcher is the exception: it shows only while the Box is enabled. `boxOpening` in the same file is the one resolution of where a Box opens, used by the launcher and the Box manager alike. A trace view belongs to its Generation, not to the Chat's Box state, so it renders whenever a captured trace exists. What runs needs an enabled Box, and the controls that start it are off otherwise. A disabled Box's window gets `staging: null`, so it shows its Move controls as unavailable; the passage timeline's catch-up is off, as are Memory's Remember, Retry and history catch-up. The host says the Box is off in this Chat in one notice, which it renders at the top of the window, under the primary panel's header and at the foot of the inspector. Setup, Box data and record overrides stay editable. The server is the gate for the rest: a Send with the Box's Moves fails, and its digests and catch-up do nothing.

#### Window and primary panel

`icon` is a `lucide-react` icon for the launcher, the window bar, the dock button, the header item and the Box manager. `Window.size` is `{ width, height }` in rem. `Window.Panel` gets:

| Prop | Use |
|---|---|
| `conversation` | the `ConversationSummary`, with `boxSetups`, `boxes`, `cast`, `control` and `revision` |
| `disabled` | true while a Prompt Plan preview is open or a Generation is assembling; disable every control that sends a command |
| `staging` | the composer's staged Moves, or `null` while the Box is not enabled, when its Move controls show as unavailable: read your own with `boxMovesOf(staging.moves, "<id>", moveSchema)` from the shared SDK, write with `staging.onChange({ ...staging.moves, <id>: [...staged, move] })` |
| `onConversationChange` | pass to `runConversationCommand` so the Chat summary updates |

`PrimaryPanel` registers a workspace primary panel, as the Author Note uses. It receives `conversation`, `disabled` and `onConversationChange`.

`Status` gets `conversation` and renders one short line, such as the World Clock's in-story time, as `ThoughtStatus` does. The host renders it, inside a `BoxBoundary`, in the dock button of a minimized window, in the header item of a Box that declares `header`, and in a Box manager row. A Box with no `Status` shows its label in the dock and "On" or "Off" in the Box manager. The accessible name is `<label>: <line>` throughout: scope e2e locators to `getByRole("toolbar", { name: "Minimized Boxes" })`, `getByRole("group", { name: "Chat tools" })` or `getByRole("group", { name: "Boxes" })`.

`header: true` puts the Box's `Status` in the Chat tools as a button that opens the Box's window, so the host refuses a client module that declares `header` without both `Status` and `Window`. Only the World Clock declares it. While the Box is disabled its item is muted and its title says the Box is off.

Every `Inspector` gets a host icon button named by `Inspector.label`; clicking opens the inspector with no message focus. This button is independent of the header item, which opens a window. Below 78rem the Chat tools group is hidden. Inspectors also appear in the Chat title menu; windows remain reachable from the Box manager, the dock and the launcher of an enabled Box.

A digesting Box builds its `Window` and `Status` with `digestWindow(descriptor, …)`, spread into its default export as `{ descriptor, ...digestWindow(descriptor, …) }`. It supplies the `Panel` (the Box's own `Panel`, if any, then the passage timeline) and a `Status` showing `status` through `useBoxStatus`. `describe(record)` replaces the timeline's generic record summary; it takes the Box's own record type.

#### Inspector

`Inspector: { label, Component }` declares a details inspector. Its label and the Box's icon supply an action on each Message and in the Chat title menu. The message action opens it with `{ messageId }`; the title menu and the Chat tools icon open it with `null`. Switching inspectors or closing one clears focus. Swipe preview prevents opening an inspector.

`Component` receives `BoxInspectorProps` from the client SDK:

- `conversation` and `onConversationChange` for reads and commands.
- `focusRequest: { messageId: number } | null` for message focus.
- `onClose` and `onNavigateSource(messageId)` for returning to the Chat or jumping to a source.
- `onOpenSettings()` for this Box's registered settings, and `onOpenConnections()` for the host's model connections.

The host wraps `Component` in an `<aside className="details-panel" data-open="true">` labelled with `Inspector.label`. The inspector supplies its header, and the host supplies one with its failure when it throws; `PanelHeader` provides the existing desktop close and mobile back controls. Disabling the Box keeps the inspector, its openers and its message action, with the host's off notice at its foot. Removing the Box closes the inspector and clears its selection so reinserting does not reopen it.

#### Settings and participant section

`Settings` is a component with no props. The host gives it a navigation-rail item with the Box's icon and descriptor label, a primary panel at `box-settings:<id>`, and a shared header. Use `useSaveGuard` and `SaveFooter` to guard unsaved changes. It remains available when the Box is disabled or absent in the Chat.

`ParticipantSection` receives `{ conversation, participant }` and renders in the Participant editor for every loaded Box, regardless of Chat enablement. Memory uses it to edit the Participant's story identity.

#### Generation trace

`TraceView` receives `{ conversationId, trace, onNavigateSource? }`, where `trace` is that Box's `BoxTrace` from `box_traces_json`. The host renders it in active Generation inspection, saved Variant details and Prompt Plan preview whenever a captured trace exists, regardless of the Box's current Chat state. In a preview, `trace.finalText` follows the editable block, or becomes empty if that block was removed. The Box checks its own trace schema and owns its display and source links; the host never reads the trace payload.

The client SDK exports the surface types, shared controls and dialogs, `PanelHeader`, `SaveFooter`, `ProfileModelPicker`, numeric controls, `useConnectionSettingsQuery`, `useAsyncEffect`, `useSaveGuard`, `useBoxRead`, conversation commands, and digest/catch-up requests. Box-specific requests stay in the Box and use `boxApi`.

### `lens`

Lifts the Box's markup out of the story view, leaving a mark that opens the window. A Box with a lens declares its tag as the descriptor's `lens`; a [delegating Box](#delegate-and-delegateapply) gets the host's lens for its tag instead of declaring one. The prompt keeps the markup. Build it inside the Box client with `createBoxLens(tag, gate, strip, describe)` from the client SDK and register it as `Window.lens`:

| Argument | Contract |
|---|---|
| `tag` | the markup tag, such as `"thought"` for `<thought>…</thought>` |
| `gate(conversation)` | a context value, or `undefined` when nothing should be lifted in this Chat |
| `strip(text, context)` | splits prose into `{ kind: "prose", text }` and `{ kind: tag, text }` segments, in order |
| `describe(run)` | one line for a run of lifted segments |

A run is a maximal row of lifted segments separated only by whitespace prose, which is dropped, so three texts in a row are one run and one mark. Any other prose between them ends the run, so each side gets its own mark. The host draws every mark the same way: a button on its own line with the Box's icon and the line from `describe`, which opens the window. Keep the line plain, since the host supplies the icon.

`strip` is also the parser the window `read` uses to list what was lifted, so it is one function in `shared.ts`. Malformed markup stays raw text. Unit-test it on malformed and nested input. [The lens pipeline](#lens-pipeline) describes how lenses combine.

## Host mechanics

### Loading

At startup the server scans the built-in folder `src/boxes/`, then the plugin folder `data/boxes/` (`/app/data/boxes` in [Docker](../docker.md)). Each child folder is one Box: the loader `import()`s its `shared-descriptor.ts`, checks the default export against the descriptor schema, then `import()`s its `server.ts`. Bun runs `.ts` directly, so a plugin's server code needs no build. A folder holding `logic.js`, or a built-in holding `logic.ts`, is a [sandboxed Box](#sandboxed-boxes): the loader reads its `descriptor.json` and evaluates its `logic.js`, or the bundle of its `logic.ts`, in QuickJS instead. An absent plugin folder holds no Boxes; any other error reading a folder stops startup. The loader refuses a Box, logs `[boxes] Refused the Box in <folder>: <reason>` and loads the rest, when:

- its descriptor fails the schema, which checks that its setup and Move schemas are TypeBox schemas and its record schema a `Type.Object`;
- its `id` names an `Object.prototype` property, such as `constructor`;
- its setup's `initial` fails its setup schema;
- its `sdk` is not the host's major, `boxSdkVersion` in the shared SDK;
- its folder is not named for its `id`;
- a Box with its id is already loaded, so a plugin cannot replace a built-in;
- either file fails to import;
- its server module fails `boxServerSchema`: each hook it declares must be a function, or an object holding the functions the host calls on it, such as `records.fold` or `advance.run`;
- its server hooks do not match its descriptor's keys, or it declares one of `records.initial` and `records.fold` without the other;
- its `routes` throw when the server builds them against its database, return anything but an Elysia app, or fail to mount under `/api/boxes/<id>`;
- it holds both `server.ts` and `logic.js`, or, built in, `logic.ts`;
- its lens or delegate tag is one a loaded Box already takes, or it breaks the [delegate](#delegate-and-delegateapply) rules;
- it is sandboxed and its `descriptor.json` uses a schema form or key a sandboxed Box cannot, or declares a digest window without a `decision` or a `decision` without one, its `logic.js` or `ui.js` fails its [build](#imports), a package fails its fetch or its hash, or its `logic.js` declares a hook a sandboxed Box cannot, or fails while it is evaluated.

The registry lists Boxes in load order: built-ins, then plugins, each folder's by name. That order is the Box manager's, the add-block menu's, the Decision Model settings', and the order Moves render in a Message. Loading happens once. [Creator Mode](#creator-mode)'s Install adds a version of a sandboxed Box without reloading the loaded ones: a new Box joins after them and takes its place by name at the next restart, and a new version of a loaded one takes its place; any other added or removed plugin takes a restart. A preset block whose Box is not loaded, as after its plugin is removed or refused, stays in the preset as `box:<id>` and renders nothing. `GET /api/boxes` lists the loaded Boxes, each with the metadata the server projects from its descriptor, `{ id, label, summary, instructions, block?, decision?, client }`, where `client` is the URL of the Box's [client module](#client-modules); a sandboxed Box carries `sandboxed`, its `descriptor.json`, in place of `client`, and a [versioned](#versions) one its `latest` as `version`. The metadata carries the presentation fields the client shows: the `label`, the `summary`, the `instructions`, and the `block` and `decision` copy. The Box manager shows a Box's `summary` when it is not in the Chat. Tests load the built-in Boxes in the `bun test` preload `src/server/test-fixtures/boxes.ts`.

### Versions

A sandboxed plugin installed through Creator Mode is versioned. Built-in Boxes, trusted plugins and sandboxed folders made by hand keep one version, replaced on restart and checked at load as [Checking stored values](#checking-stored-values) says. A versioned Box's folder holds:

```text
data/boxes/<id>/
├── versions/<hash>/   descriptor.json, logic.js, ui.js, ui.css, deps.lock.json, deps/, bundles
├── latest             the hash new Chats pin
└── checks/            <version>-<scenario>.json, cached run_scenario results
```

`<hash>` is the sha256 of the version's source files and `deps.lock.json`, sorted by path; packages and bundles are built from them, once, in staging. Nothing writes into a version folder after it is created, and creating one that exists leaves it alone (`src/server/box/versions.ts`). No version folder is removed.

**Install** refuses a version that drops `delegate` or renames its tag while `latest` delegates, since Chats hold requests in that tag, and a tag another loaded Box takes or an Install in flight claims. It refuses a version that drops `decision` while `latest` digests: Decision Model settings are listed from the catalog, and Chats pinned to a digesting version keep needing them. A union holding a row reference must stay exactly as it is, since Fork picks a branch by the stored value.

**Two kinds of lookup.** The catalog is `latest`: the registry's `serverBoxes()`, the shared `installedBoxes()` and the client's `loadedBoxes()` list it, and a Box's label, summary, icon, `startsEnabled`, and the instructions and role a new preset block starts with come from it. Everything a Chat runs, its hooks, schemas, Moves, records, read, digest and window, resolves the version the Chat pins first: `chatBoxes(db, conversationId)` on the server, `chatBoxClient(conversation, id)` on the client, which keys each version `<id>@<hash>`. A pinned version that is not loaded throws rather than reading `latest`.

**The pin.** By default, each Chat pins one version of each versioned Box it ever held, in `conversation_data` under the host's `box-version` namespace, keyed by the Box id, outside the Box's [lifecycle](#lifecycle-per-chat) namespace. The first insertion pins `latest`; removal keeps the pin, since it says which version reads the Chat's history; inserting the Box again runs the pinned version; Fork copies it. Choosing to delete the Box's history when removing it also deletes the pin, so inserting it again pins `latest`. The Chat summary carries the pins as `boxVersions`.

**Upgrade.** `{ type: "upgrade-box", box, version }` moves the pin to `latest` or any earlier version, which the Box manager offers as **Update** once `latest` moved. In the command's one transaction it checks the Chat's stored data against the target and writes nothing until every place passes: every record slot on every Variant, automatic and writer, of every instance, against the record schema; every Move list against the Move schema and `max`; records or Moves the target no longer declares; the stored setup against the setup schema and `setupError`; each Chat and Participant value against its declared schema; and every place Fork remaps an id, each `rowReference` and each Record keyed by `ParticipantKey`, identical by path. A refusal lists each failing place. A passing upgrade writes only the pin, keeping the insertion instance so every record still folds, and advances the Chat's revision. It checks each stored item, not each fold a later selection could produce.

**Stale work drops by equality.** A Generation's pending record carries the version it was captured under, and settling writes it only while the Chat still pins that version; the prose lands either way. A digest job carries its version and lands only while the pin matches. The preview fingerprint includes each Box's version. A window commit names its frame's version and is refused at any other, and a frame token stops answering once the pin moves, so a second tab's old window writes nothing after an upgrade. Each version's `ui.js` and `ui.css` are served at `/boxes/<id>/versions/<hash>/`, cached for good, and the window's content is keyed by version, so an upgrade remounts it; the Box manager's **Update** asks the save guard first.

**Loading.** Startup loads each versioned Box's `latest`. Any other version loads the first time something needs it: a request under `/api/conversations/:id` loads every version that Chat pins before the route runs, startup recovery loads those of Chats with an Active Generation, and an upgrade loads its target. A version stays loaded until the next load; none is unloaded, since queued digests resolve their runtime late and history keeps needing its version after the Box is removed.

### Client modules

A Box's `client.tsx` builds into one ES module, `client.js`, its dynamic imports inlined, with the host modules left as imports: `react`, `react/jsx-runtime`, `react-dom`, `@tanstack/react-query`, `@sinclair/typebox`, `@sinclair/typebox/value`, `@/box-sdk/client` and `@/box-sdk/shared`. `hostModules` in `scripts/host-modules.ts` lists them, and the Vite config injects it into `index.html` as the page's import map in the dev server and the build alike; the host build emits each as a stable `/host/<name>.js` chunk, so every Box shares the host's React, its React Query client and its TypeBox registries. `bun run build` builds each built-in Box's module into `dist/boxes/<id>/`, and `bun run box:build <folder>` a plugin's into `<folder>/dist/`. A stylesheet `client.tsx` imports is built with Tailwind against the host's theme and emitted beside it as `client.css`, and the module links it and waits for it to load. The server serves both files, and no other, at `/boxes/<id>/`, from `dist/boxes/<id>/` for a built-in and `data/boxes/<id>/dist/` for a plugin; for a sandboxed Box it serves the `ui.js` and `ui.css` the loader read from its folder, or bundled from a built-in's `ui.ts`, instead; `bun run build` and `box:build` skip a Box without `client.tsx`. Browsers revalidate them and the host chunks, since their names do not change between builds. The Vite dev server serves a built-in's module from its source instead.

At startup the client reads `GET /api/boxes`, then imports every module in parallel, before it renders. It builds a sandboxed Box's client from its descriptor instead: the descriptor, its icon, and a window that mounts the Box's frame. It checks each default export against `boxClientSchema` (every surface a component, a window with a size), its descriptor as the server does, and that its `id` is the listed one, then installs every listed Box in registry order with its metadata and its module or the reason the module did not load. A module that fails to import, or that the client refuses, shows none of its surfaces, and its row in the Box manager says `Did not load: <reason>`. The metadata is the server's either way, and `boxMetadata(id)` in `src/shared/contract/box.ts` reads it on the server and the client alike. `boxDescriptor(id)` throws for a Box whose client module did not load, naming it. A Box whose client module failed still has its label, its preset block's copy and its Decision Model settings, so the preset editor names its block and Connection Settings still selects its model. Only the surfaces that read a schema or a Move label, such as its window, wait for the module. The Box manager lists every Box `GET /api/boxes` lists, so it still turns such a Box on or off or removes it: the server runs a Box whether or not its client loads. The cache is shared, so a Box's query keys start with its id, such as `["memory", "memories", conversationId]`.

### Folder and SDK

Each file in `src/boxes/<id>/` takes its layer from its name. A layer with several files prefixes each name, such as `server-engine.ts`, `shared-data.ts` or `client-oval.tsx`. Tests sit beside the file they test.

| File | Layer | Holds | May import from the host |
|---|---|---|---|
| `contract*.ts` | shared | TypeBox schemas and their types | `@/box-sdk/shared` |
| `shared-descriptor.ts` | shared | the descriptor, as its default export | `@/box-sdk/shared` |
| `shared*.ts` | shared | logic the server and client both use | `@/box-sdk/shared` |
| `server.ts` | server | the server Box, as its default export | `@/box-sdk/server`, `@/box-sdk/shared` |
| `server*.ts` | server | the server Box's other modules | `@/box-sdk/server`, `@/box-sdk/shared` |
| `client*.ts(x)` | client | the registered surfaces and their helpers | `@/box-sdk/client`, `@/box-sdk/shared` |

The layer rules read Box file names too: a `client*` file imports `server*` code only for types, a `shared*` or `contract*` file imports neither, and a `Type.Object` in a `server*` or `client*` file fails `bun run lint`. The SDK entries re-export only what the built-in Boxes use; read them for the list. The server entry exports no table: a Box reaches its stored data through the reads and writes in [Storage](#storage), and a host fact it checks through a read of its own, such as `readProfileApiFormat` for a Connection Profile's API format, so a change to the host's schema changes no Box. When a Box needs something else from the host, add it to its layer's entry.

### Storage

| Scope | Table | Written by |
|---|---|---|
| Library | `library_data (namespace, key, value)` | the window, through `commit-box` |
| Character | `character_data (character_id, namespace, key, value)` | the window, through `commit-box` |
| Participant | `participant_data (participant_id, namespace, key, value)` | Character data copied when it seeds a Participant (a loaded Box's undeclared keys excepted); then the window, through `commit-box` |
| Conversation | `conversation_data` | the host: `enabled`, `instance`, `setup`; the Box: every other key |
| Message | `messages_data` | the host: `moves` |
| Variant | `message_variant_data` | the host: `record:<instance>` slots |

`{ type: "commit-box", box, setup?, writes?, expected? }` is one atomic batch of a Box's own values, with its setup when it carries one. It takes the Box id, not a namespace, and a sandboxed Box's frame names its own. Each write is `{ owner, key, value }`, the owner being the Library, a Character this Chat's Cast was seeded from, or a Participant of this Chat; a Participant value must be JSON its declared schema accepts. The Chat revision guards the setup and Participant values. Library and Character values are shared across Chats, so `expected` lists each one's `{ owner, key, revision }` as last read (0 when absent), and every Library or Character write needs its own; a stale one refuses the batch. The host rejects it for a Box absent from the Chat, as it does a setup, and for an owner that does not exist, and one refused write or setup lands nothing. Generic `put-data` and `delete-data` refuse every `box:` namespace, loaded or not. Uninstalling a plugin or refusing it at startup leaves its stored data intact. Removing a Box from a Chat clears its Conversation data, including setup and instance, and its Participant values; historical Moves and records stay unless the writer chooses to delete this Box's history in the confirmation, which also clears its pin and pending Generation records in that Chat. The host's commands own these namespaces in each case. Values are strings the Box decodes; a value that fails its schema is an error, never a row to skip. Character and Participant data are independent after the copy.

A Box's server code reads and writes its data through the server SDK. Each Box-scoped helper takes the Box's id and fixes the `box:<id>` namespace from it, so a Box names only an id, never a namespace or table; the host does not check which Box is calling. The SDK has only the operations the built-in Boxes use: `readLibraryValue` and `putLibraryValue` for one JSON Library value and its revision, as Memory's settings. A sandboxed Box reads through [`snapshot`](#sandboxed-boxes) instead. `commit-box` writes Library, Character and Participant values through the same writes. A Box reads and writes its own Chat values through `readChatValue` and `putChatValue`, which own one read, guard and write. Their revision is an opaque token carrying both the Box's insertion `instance` and the row's revision, so a value read before the Box was removed authorizes nothing after it is inserted again, even at the same row revision. Disabling keeps the instance, so a write with a current token still lands while the Box is off. Only a Box present in the Chat keeps Chat values: the SDK refuses a write for an absent one. The host's three lifecycle keys, `enabled`, `instance` and `setup`, are its own, and the SDK refuses to read or write them. A digest's `window.data` carries the Box's other keys but none of those.

A record slot is `{ automatic?, writer?, source?, error? }`, keyed by the instance that wrote it. A slot with no automatic record, Writer override or error has no row. `source` hashes the digested text, so an edit is digested again and a reselection is not. `error` is `{ source, message }`, the last failed digest and the hash of the text it failed on. `slotStatus(slot, content)`, from the server SDK, classifies a slot against its passage's current text: `missing`, `fresh`, `stale` (a result for an earlier text, which still folds) or `failed` (a digest failed on this text), or `overridden` around one of those. A Writer override settles the passage, so a failure beneath it needs no attention; the digest queue still digests beneath it, so Reset restores a result for the current text. The timeline and Memory reads send this status, so no client classifies a slot. Each Variant also holds one Generation seed shared by every Box, under namespace `box`, key `seed`. A Box's stream hashes it with the Box id. A Variant with no seed, such as an imported one, uses `variant:<id>`.

Setups, records, Moves and Decision Model selections are decoded against their schemas on every read, and commands check them before they land. A value that fails to decode is an error naming the namespace or key; [checking stored values](#checking-stored-values) at load keeps a schema change from leaving one behind.

### Checking stored values

At load, before the server serves, the host fingerprints each unversioned Box's stored-value schemas (a [versioned](#versions) Box moves Chats between versions only through the upgrade check): its setup, declared Chat and Participant values, record, Moves and `advance.trace`. The fingerprint its values last all passed under is kept in `box_schema`. When it changed, every Chat's values for the Box are checked against the new schemas, one Chat write each, in `src/server/conversation/box-values.ts`:

- A value that passes is left alone.
- One that fails goes to the Box's `upgrade(stored)`, if it declares one. `stored` is `{ kind, value }`, `kind` one of `setup`, `chat`, `participant`, `move`, `record` or `trace`, with `key` for a Chat or Participant value; each Move and each record (automatic and Writer alike) is upgraded on its own. The host writes the result when it passes and ignores it otherwise; an upgrade declines a value by throwing.
- One that still fails is deleted when it is derived: an automatic record (with its `source`, so a catch-up digests the passage again), an interrupted Generation's pending record, or a trace (the Generation keeps its budget evidence).
- Anything else a person wrote, so it is held: left as it was, so reads of it still fail, and listed by place at `GET /api/box-held-values`. The Boxes panel names each Box's count above the Box manager, even when a held setup keeps the Chat from loading, and offers **Clear**, which posts to `/api/boxes/<id>/held-values/clear`, deletes them and reloads the Chats.

A Chat whose values changed advances its revision. The fingerprint is recorded only once nothing is held, so a Box with held values is checked again at the next load. Library and Character values are read with the schema the Box passes at the time, so the host cannot check them; a Box that changes one handles its own old values. A feature that needs relational queries stays in-tree code that owns its tables, like Lorebooks and the `embed` service's cache.

### Lifecycle per Chat

The host stores `enabled: true | false` and an `instance` id as two rows in `conversation_data`. Neither row means absent; only one row is corrupt and throws an error naming the Chat and Box. Server code and the server SDK read each present Box's `{ state: "enabled" | "disabled", instance }` with `readBoxLifecycles` in `src/server/box/setup.ts`. `readBoxStates` projects the Chat summary's states; client code reads `conversation.boxes[<id>]`.

| State | Runs | Keeps |
|---|---|---|
| enabled | [captured](#generation-lifecycle) into Generations, digests, accepts Moves | everything |
| disabled | nothing, though its Chat surfaces stay and its setup, data and records stay editable; re-enabling picks up where it left off | setup, data, instance |
| absent | nothing, and it has no Chat surfaces | Library and Character data; Variant records and Message Moves by default |

Removing, after confirmation in the Box manager, deletes the Box's `conversation_data` (its instance included) and this Chat's `participant_data` in its namespace. Each insert creates a new instance; disabling keeps it. The fold reads only the current instance's slots, so a reinserted Box starts from `setup.initial` and `records.initial` while its old records stay stored; a [versioned](#versions) Box's pin stays too. The confirmation also offers an unchecked option to delete this Box's history in this Chat: every instance's record slots on every Variant, selected or not, its Moves on every Message, its version pin and its pending Generation records are deleted in the same transaction. Generation traces, Library and Character values, other Chats and Boxes, and the shared preset block stay. A Box writes no filter for this. One Chat holds at most one instance of each Box.

Turning a Box on, at creation or later, adds its [preset block](#preset-block) when the Chat's preset has none. Disabling or removing reports `stoppedBox` on the Conversation change. The digest queue drops that Box's jobs and aborts those in flight. A new Chat starts with the `startsEnabled` Boxes, today the Author Note and Memory. No Box is exempt from removal. The writer manages Boxes in the Box manager, which adds a Box, turns it on or off, opens it and removes it.

### Generation lifecycle

1. **Capture.** For each enabled Box whose preset block is enabled, the host reads its setup, its folded state, the Moves, and its `dependencies`, in the one read transaction that reads the rest of the Generation's inputs. A swipe reuses the seed of the Variant selected at its Message; every other Generation, re-roll included, gets a new one.
2. **Advance.** Records and traces are held on the Active Generation with the captured instance and copied to the Variant when it resolves.
3. **Admission and budget.** The block's instructions and its items pass through the Prompt Macro pass, except literal items. Pinned items are admitted first, ignore the allowance, and count toward the context limit. Then each unpinned item, by descending `priority`, is admitted whole if it fits both `allowance` (or the remaining context when none is given) and the context limit. `allowance` counts items only; the instructions count toward the context limit. The block renders its instructions, a newline, then the admitted items in that order, separated by blank lines. A plan that still overflows the context, pinned items included, raises `PromptBudgetExceededError`. Each item's admission reaches inspection in the Box's [trace](#advance).
4. **Preview fingerprint.** The host fingerprints the whole preparation snapshot, seed included, with each participating Box's instance, setup, state, Moves, `dependencies` (or its `fingerprint`) and its Decision Model selection, credential left out, so changing the selection marks a preview stale. Sending from a preview reuses that capture and sends the inspected plan without advancing any Box again; if the fingerprint changed meanwhile, the Send fails with "The Prompt Plan is stale. Refresh it before sending."
5. **Digest.** Resolution queues the Variant's [digests](#digest-queue-and-catch-up). Generations never wait for digests, and a finished Variant keeps the inputs it was generated with: a digest that lands later changes only what the next Generation folds.

### Preset block

Each Box has at most one block per preset, reference `box:<id>`, labelled and given its starting role by the descriptor; a partial unique index on `(preset_id, reference)` holds that. The block's `content` is its instructions. Every new block, from the add-block action or from turning a Box on, copies the descriptor's `instructions`; from then on the text belongs to the preset, and changing the descriptor never rewrites an existing block. The preset editor shows the instructions as an editable text area, a read-only line marking where the Box's content goes, and **Reset to <Label> default**, which restores the descriptor's text into the draft. A block renders nothing when its Box is not captured, or when `advance` returns no items and the descriptor has no `alwaysRender`, so instructions never reach the prompt without the content they introduce. The add-block menu lists every Box. The block constraints accept any `box:` reference, so a new Box needs no migration. A Box On in a Chat whose preset lacks its block gets one, placed right after the last history block with the descriptor's role, exactly as the add-block action places it: `installBoxBlocks` in `src/server/prompt-preset/blocks.ts` runs in the same transaction as creating a Chat and as turning a Box on. Presets are shared and a block produces output in every Chat where its Box is On, so another Chat on the same preset with that Box On starts sending it too. A block that exists stays as the author left it: a disabled block stays disabled, and the Box manager row and the Box's window say "<Label> block is off in <preset>" with an Enable action. A Chat that switches to a preset without the block, or whose block an author deletes, gets the same notice with Add block. The preset decides where a Box goes; the Chat decides whether it runs.

### Digest queue and catch-up

A [delegating Box](#delegate-and-delegateapply)'s tagged passages run in this queue as delegate jobs, under the same rules, one at a time per Chat and Box in passage order; catch-up queues its tagged passages without a record for their text, failed ones included, and `/digest` retries one. A touched passage whose text changed drops its current job when the change commits, even when the new text queues nothing. The host queues a digest for a selected, settled, non-empty Variant when it resolves, when it becomes selected without a record for its current text, or when its text is edited. Two workers drain the queue, live jobs before catch-up jobs. Each Variant and Box has one current job: a newer one aborts the older, and only the current job's result lands. A result, or a failure, is discarded if the text changed, the job was replaced or cancelled, the Box stopped being enabled, its instance changed, or the Decision Model selection went away. A failed digest is not queued again for the same text; an edit queues it, and so does catch-up. A successful digest clears the slot's `error`. Jobs live in memory; work lost on restart is queued again on the next selection, resolution or edit, or by catch-up.

Catch-up queues every selected Variant without a record for its current text, failed ones included, behind live work. The window shows its progress, with how many failed, and can cancel it. A second request while one runs does nothing. `POST /api/conversations/:id/boxes/<id>/digest` with `{ variantId }` queues one selected passage now as live work, retrying a digest that failed on its text and leaving one already digested for it alone; Memory's Remember and Retry actions use it.

### Passage timeline

`src/client/box-windows/PassageTimeline.tsx` ends every digesting Box's window. It lists the Selected path's non-empty passages, each with its effective record (or "Not read yet"), an "Overridden" mark, a "Digest failed" mark carrying the error when the last digest of its current text failed and no override settles it, Edit and Reset. "Digest missing passages" starts catch-up. Without a Decision Model selection it tells the writer to pick one in Connection Settings. It polls while open, faster during catch-up; a minimized dock button reads only the status.

The override editor is built from the `record` schema:

| Field schema | Editor |
|---|---|
| a union of `Type.Literal`s, optionally with `Type.Null()` | a select, one option per member |
| `Type.Integer()` or `Type.Number()` | a number input bounded by `minimum` and `maximum` |
| `Type.String()` | a text input |

Any other field type, and any `Type.Optional` field, throws when `digestWindow` builds the window, so the Box's client module fails to load. A field that may be unset is a union of literals with `Type.Null()`. Each schema's `title` labels its field or option, such as `Type.Literal("rain", { title: "🌧️ Rain" })`; without one the key or value shows, and `null` shows as "None". A new draft starts a nullable choice at `null` and leaves other fields empty. Save stays disabled until the draft passes the schema.

The generic summary joins the fields with ` · `: a choice shows its option's title, a number or string its value, and a `null` field nothing. A Panel that changes something `status` depends on, such as setup, refreshes the timeline and the `Status` line with `client.invalidateQueries({ queryKey: boxDigestKey(conversation.id, "<id>") })`, or passes that as `onSaved` to `useBoxSetupDraft`.

### Lens pipeline

The story view applies the lens of each Box present in the Chat whose `gate` returns a value, at the version the Chat pins (`chatBoxClients`), in registry order, each to the prose the earlier ones left. A lifted piece is never lensed again. A lens that throws, or returns pieces that fail their schema, shows its failure and leaves the prose unlifted, and the host draws each lifted mark in the story. While a Message streams, an unclosed `<tag` is hidden instead of flashing as raw markup.

### Move staging

A Panel stages Moves through `staging`. They show as chips above the composer text, which the writer can drag to reorder or remove. A Message may hold only Moves. In the story, a Message shows its Moves as chips.

A Send with Moves for a Box that is not enabled is rejected. The composer drops staged Moves for a Box that stops being enabled, and seat-bound ones when the human seat changes. A Send that retries an existing Human-authored Message keeps the Moves already stored on it. `set-message-moves` replaces a past Message's Moves, but not while a Generation runs; regenerating its reply replays the turn.

### Windows and dock

The composer shows a launcher button for each Box enabled in the Chat with a primary panel, which it opens, or else a window, in registry order. An off Box has no launcher: its window is opened from its name in the Box manager, its header item where it declares one, or its dock button. The Box manager also lists and adds every other Box. Windows drag but do not resize, several can be open at once, and Escape closes one. Minimizing turns a window into its dock button, at the bottom-right beside the composer, which the host draws with the Box's icon and `Status`. Open state, minimization and position are client-side, per Chat, in local storage. Below 78rem wide, the top window becomes a full-screen layer with focus trapped inside.

The host styles the frame, the dock and the passage timeline in `src/styles/box-windows.css`. A Box styles everything inside them in its own stylesheet, imported from `client.tsx`. Every selector in it names one of the Box's classes, `<id>` or `<id>-…`; the build fails on one that doesn't, since it could match the host's elements or another Box's. Start the stylesheet with `@reference "@/index.css";` to write Tailwind utilities with `@apply`, as `src/boxes/thought/client.css` does. The host compiles no utility from a Box's folder, so a utility in a `className` works only where the host happens to use it too; don't rely on one. Semantic utilities (`text-muted-foreground`, `bg-muted`, `border-border`) and the host's variables (`var(--text-faint)`) follow the user's light or dark theme; palette colours such as `text-amber-500` don't. A Box's class on an SDK component overrides the component's own styles. Follow `DESIGN.md` for visual decisions.

## Built-in Boxes

| Box | Starts enabled | Declares |
|---|---|---|
| Author Note | yes | `setup`, `advance` |
| Memory | yes | `record`, `decision`, `dependencies`, `records.digest`, `advance` with `trace` and `fingerprint`, `routes`; no window, its own side panel |
| World Clock | no | `setup`, `record`, `decision`, `setupError`, `records.digest`, `advance`, `status`; `digestWindow` with `Panel` and `describe`, and `header` |
| Race | no | sandboxed: `setup`, `record`, `moves`, `setupError`, `dependencies`, `records`, `advance`, `read`; frame window |
| Phone | no | `instructions`, `lens`, `moves` (seat-bound), `dependencies`, `advance`, `read`; window and lens |
| Thoughts | no | `instructions`, `alwaysRender`, `lens`, `read`; window and lens |
| Mood | no | sandboxed: `instructions`, `record`, `decision`, `records.digest`, `advance`, `status`; digest window |

**Author Note.** Setup is the note text, Image References included. `advance` returns it as one pinned item, or nothing when blank. It has no instructions. Lore scanning, Semantic Trigger judging and Memory extraction never read it. It edits in the workspace's primary panel, not a Box window.

**Memory.** It has no instructions. It digests like the World Clock and Mood, and its digest also calls an extraction model. Its record is `{ claims }`, each claim an attributed statement with its people, its evidence excerpts and the Decision Model's judgment. A digest reads the passage with up to four preceding Messages, trimmed to the extraction context; asks the extraction model chosen in Memory Settings through `ctx.llm`, with the Chat's identity sentences and Memory note; has `ctx.decide` judge each candidate's support, attribution and usefulness; keeps the supported, correctly attributed ones whose retain probability meets the minimum; and embeds what it kept through `ctx.embed` with `cache`. A passage by an author who is not in the story digests to no claims. Its Decision Model is the host's selection for the Box. Identities and label merges apply when claims are shown and recalled, never to stored records. Editing or removing a claim writes the passage's whole claims list as its Writer record through `set-box-record`; reset drops that record and the automatic claims return. A passage is extracted again only when its text changes. `advance` is recall over the Selected path's effective records, read from the slots on `CaptureRead`'s `messages`: it embeds any claim text the cache lacks, such as a Writer's edit, shortlists by embedding similarity and recency, and has the Decision Model score relevance, returning literal claims prioritized by relevance under Memory's allowance, and its activation record as the trace. `fingerprint` is the recall snapshot's freshness fingerprint: Memory's settings, allowance, labels and Writer records mark a preview stale, as its Decision Model selection does through the host, and a digest landing in the background does not. Its side panel lists each passage's claims from the record slots, with the slot's `error`, and starts catch-up through the host. Its `routes`, in `server-routes.ts` under `/api/boxes/memory`, serve that panel, its settings editor and its trace view, which links only to the sources still in the Chat; its `client-api.ts` calls them. Its `client.tsx` registers the Memories inspector, an icon-only Chat tools item, settings editor, Participant identity section and recall trace view. All UI, helpers, tests and styles live in its folder; imports from the host go through the client SDK.

**World Clock.** Setup is a naive Gregorian start (`YYYY-MM-DDTHH:mm`; `setupError` rejects dates such as February 31), an era suffix (default `AD`), a climate (temperate, tropical, arid, cold), a hemisphere and a unit (default °C). A digest reads the passage with one preceding Message and asks two `choice` questions: the elapsed time (`none`, `~5m`, `~15m`, `~30m`, `~1h`, `~2h`, `~4h`, `~8h`, `overnight`, `~1 day`, `several days`), with the exact minutes drawn inside the bin from `seed`; and the weather established (`not mentioned`, `clear`, `cloudy`, `rain`, `storm`, `snow`, `fog`). The record is `{ minutes, weather }`. The fold adds minutes and keeps the latest weather with the minute it was mentioned; the clock stops showing it 24 in-world hours after that. Temperature follows climate, hemisphere, season, hour and weather. It has no instructions: `advance` pins one line, `8:41 AM | 🗓️ Saturday, December 20, 2025 AD | ☀️ Clear, 3°C`, omitting unknown weather; without a Decision Model selection the clock stays where it is. Status is `8:41 AM · ☀️ 3°C`.

**Phone.** Texts live in the prose as `<sms from="…" to="…">…</sms>`. The instructions teach the markup, with `{{other}}` texting `{{self}}` as the example. `advance` pins one line naming the human's contacts (the other Cast members), `Night Desk has a phone and can text Theodora Kline.`, or nothing when there is nobody to text, which also drops the instructions. Outgoing texts are seat-bound Moves rendered as `<sms>` from the Message's author, so a texting-only turn is a Moves-only Message. The lens lifts a text only when one end is the human-controlled Participant and the other a Cast member, matching names case-insensitively. The read groups texts, the human's sent Moves included, into one thread per contact. Unread counts are client-side view state, never in the prompt; the `Status` line shows `2 unread`.

**Thoughts.** The instructions ask for unspoken thoughts as `<thought>…</thought>`. It has no `advance` and declares `alwaysRender`, so its block is the instructions alone. The lens lifts every thought, and the read lists them along the Selected path. In nested markup only the innermost pair matches. The `Status` line counts thoughts.

**Mood.** A digest asks one `choice` question over the passage and one preceding Message: `not clear`, `calm`, `warm`, `playful`, `tense`, `sad` or `eerie`. "Not clear" keeps the previous mood. The instructions are `Scene mood:` and `advance` pins the mood, `tense`, so the block reads `Scene mood:` then `tense` on the next line. Status shows the emote and word, `😬 tense`. It is a [sandboxed Box](#sandboxed-boxes): `descriptor.json`, with `window.kind: "digest"`, and `logic.ts`, whose digest asks through `decide`. The generic timeline and `Status` are its whole surface.

### Worked example: the Race

The Race is a built-in [sandboxed Box](#sandboxed-boxes) and uses most of its contract. Its files in `src/boxes/race/`: `descriptor.json` (the descriptor, its schemas as JSON), `logic.ts` (the hooks), `logic-engine.ts` (the simulation), `shared.ts` (its types, Move rules and status line for both logic and window), `shared-data.ts` (bundled courses, roster, seeded random), `ui.ts` and `ui-markup.ts` (the window) and `ui.css`. The loader bundles `logic.ts` into QuickJS and `ui.ts` into the frame's Worker; neither imports the SDK. Its Move label is `"{kind} · {runner}"`, each `kind` literal titled `Overtake`, `Conserve`, `Spurt` or `Hold`.

It has no trace. It has no `decision`, so it does not digest, serves its own `read`, and gets no override editor; its slots hold only `automatic` in practice.

**Setup.** `raceId`, the course (one of eight bundled courses, or a custom distance, surface and direction), metres per Stretch, up to 18 slots, Auto mode (`off`, `on`, `{ until }`) and `phase` (`setup` or `running`). Whether the race finished is folded state. "Start race" saves the draft with a new `raceId` and `phase: "running"`; "New race" saves `initialRaceSetup` with another new `raceId`. `setupError` rejects course or field changes once a race is running, an Auto stop beyond the course, two gates with one name, and a running race without an id or two Runners.

**Field.** Slots are Cast members plus roster Runners drawn by "Fill field" with seeded stats biased by Running style. A roster Runner sharing a Cast member's name is excluded. Stats are Speed, Stamina, Power, Guts and Wit, plus a Running style (Front Runner, Pace Chaser, Late Surger, End Closer, named as in the game's English localization so "Runner" stays free for entrants). A Cast Runner's stats are its Participant's, copied from its Character on seeding and edited by the writer afterwards; slotting one without stats opens a stat sheet to roll or set them, which can save back to the Character. The repository ships no Runner art: `bun run db:seed:race-avatars` loads roster avatars from the gitignored `race-avatars/` folder, or the writer sets one in the window.

**Dependencies.**

```ts
dependencies: ({ seed, intent, cast }, setup) => ({
  seed, intent, withdrawn: setup.slots.flatMap(({ name, participantId }) => participantId !== undefined && !cast.some(({ id }) => id === participantId) ? [name] : []),
}),
```

`withdrawn` lists slotted Cast Runners whose Participant has left the Cast. The Race declares no `fingerprint`: the default fingerprints these dependencies, so a new seed or withdrawal marks a preview stale.

**Records and fold.** A record is the race after its turn: standings, energy and Hidden intents, and in `entries` the replay entry the turn added. A Stretch adds one; a withdrawal during a Hold, a walkover and the Results Stretch add none, so records stay the same size however long the race runs, and an 18-Runner race folds 200 Stretches in one sandboxed call in about 35 ms. `foldRace` takes the standings and intents from the last record of the current `raceId` and appends each record's entries, starting fresh when the race changes, so old races never leak into a new one. `racePhase(setup, state)` reads where the race stands, treating state from another `raceId` as initial: `setup` before the start, `running` while a Stretch is due, `crossed` once the field is over the line and the Results Stretch is due, and `finished`, a walkover included. Its `auto` says whether Auto advances the race on a continue turn. The engine, the Moves and the window all read this one phase. Withdrawals only drop standings, so a standing whose Runner holds no gate means the `raceId` was reused for another field: `advanceRace` refuses that state with an error naming the Runner instead of resuming it.

**Advance.** `advanceRace` is a pure function of setup, state, Moves, seed and intent; all randomness comes from `raceRandom(seed)`, so equal inputs, withdrawals included, repeat the outcome. One call:

1. Returns nothing unless the race is running with at least two Runners. A continue intent advances only under Auto, and `{ until }` stops it `until` metres before the finish.
2. Resolves the writer's Moves in order with `checkRaceMove`, so a Move that turned illegal fizzles with its reason.
3. Has the engine decide for every other Runner from Running style, stats, energy and position, across four phases: opening, middle, final corner and last spurt.
4. Simulates the Stretch in 20 fixed steps. Stretches shorten to at most 100 m in the final 400 m.
5. Picks two or three salient events, scored double for Cast Runners, plus foreshadowing and reveals for Hidden intents.
6. Writes the item: course, Stretch range, standings, events, Move results, intents and "Narrate only this Stretch. Do not go past N m."

The Race has no instructions: every line of its item changes per race or per Stretch, and the closing line differs between a Stretch, a Hold and the finish.

Once the field crosses the line, one Results Stretch gives finishing order, margins and outstanding reveals, with "Narrate the finish." After it the Race returns nothing until a new race.

`advance.run` in `logic.ts` wraps that for Hold and withdrawal. A lone legal Hold on a respond turn returns a pinned item and no record, so the race stands still. A withdrawal is announced once and persisted as a record even when no Stretch runs, so it does not repeat on every Hold. A field cut below two Runners ends in a walkover. Every item is pinned at priority 100: a Stretch reaches the model whole or not at all.

**Moves.** Overtake, Conserve, Spurt and Hold, each acting on the human seat's Runner, or as an order to a chosen Runner when the human seat is not racing. The window offers each legal Move with its projected cost and odds from `checkRaceMove(setup, phase, staged, move)`. Moves are off while Auto advances the race: always under `on`, and until `until` metres before the finish under `{ until }`. `render` gives `(Race Move: Special Week tries to overtake.)`; once the Race is not enabled, history shows the chip `Overtake · Special Week`.

**Data scopes.** Library: roster avatars, keyed `avatar:<name>`, each an Image the window uploaded, then committed with the avatar's revision. Character and Participant: `stats`. A stat sheet's `stats` ride as writes on the commit that adds the gate, with the Character's revision in `expected`, so the gate and its stats land together. `read` reads all three through `snapshot`.

**Window.** `ui.ts` shows setup and stat sheets before the start, the SVG oval (Portraits for Cast Runners, roster avatars otherwise, as HTML markers that glide between Stretches) and Move controls while running, and a replay of every Runner's decisions per Stretch after the finish. Its setup draft and open stat sheet join the window's save guard. `read` sends the `racePhase` of the host's fold with the spectator state, the setup, the Cast and the revisions a commit needs, and the status line, `🏇 1500m · 3rd` while running or `🏁 1st · Special Week` when finished, which the host shows.

**Tests.** `logic-engine.test.ts` checks determinism for equal inputs and the fold across `raceId`s; `logic-withdrawal.test.ts` covers withdrawals; `logic-sandbox.test.ts` folds 200 Stretches through the sandbox. `src/boxes/race/*.spec.ts` starts a race, advances it with Moves, swipes for the same outcome and re-rolls for a new one, asserted through Prompt Plan inspection.
