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

## Where to read next

| Work | Read |
|---|---|
| Write or install a trusted Box; use hooks, client surfaces, Row References, or the SDK | [Authoring a trusted Box](authoring.md) |
| Write or install a sandboxed Box; work on its descriptor, imports, logic, digest, UI, or versions | [Sandboxed Boxes and versions](sandboxed.md) |
| Work on Creator Mode, scenarios, export, submission, or installation | [Creator Mode](creator-mode.md) |
| Work on loading, client modules, storage, lifecycle, generation, digests, timelines, lenses, Moves, or windows | [Box host mechanics](host.md) |
| Look up a built-in Box or the worked Race example | [Built-in Boxes](built-in.md) |
