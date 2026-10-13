# Box system

A **Box** is a compiled-in story feature with its own state and a fixed set of optional hooks. It turns its state into prompt items through its own Prompt Preset block. It may also resolve Moves the human attached to a Message, read settled prose in the background, and render a floating window that minimizes to a dock. The host stores, orders and routes Box data and never interprets it. [ADR-0050](../adr/0050-build-story-features-as-boxes.md) records why Boxes exist and which designs were rejected.

## The contract

A Box is three registrations and its folder `src/boxes/<id>/`. The shapes below are a summary; the types live in `src/shared/contract/box.ts`, `src/server/box/contract.ts` and `src/client/box-windows/registry.tsx`.

```ts
// 1. Descriptor: the id in `boxIds` and its `boxDescriptors` entry, src/shared/contract/box.ts
"<id>": {
  label: "…",                                        // display name everywhere the host shows the Box
  role: "system",                                    // the preset block's role until an author changes it
  startsEnabled: false,                              // whether a new Chat starts with the Box enabled
  instructions: "…",                                 // the text a new preset block starts with; "" for none
  alwaysRender: true,                                // optional: render the block even when `advance` returns no items
  setup: setupOf(schema, initial),                   // optional: per-Chat configuration
  record: Type.Object({ … }),                        // optional: one Variant's record, folded into state
  moves: movesOf(schema, max, label),                // optional: actions on a Human-authored Message; add `seatBound: true` to drop them on a seat change
  decision: { summary, description, off, context },  // optional: digest settled prose; copy for its Decision Model setting
},

// 2. Server Box: src/boxes/<id>/server.ts, listed in `serverBox` in src/server/box/registry.ts
export const exampleBox = {
  inject: ["llm", "decide", "embed"],                // provider services `advance.run` and `digest.run` receive on `ctx`
  setupError(setup, previous) { … },                 // a message rejecting a setup the schema accepts
  moves: { render(move, author) { … } },             // a Move as history reads it; required by `moves`
  dependencies(read, setup) { … },                   // inputs beyond setup, state and Moves, from the host's CaptureRead
  records: {                                         // required by `record`
    initial,                                         // state before any record
    fold(state, record, setup) { … },                // one effective record into state
    digest: { window: 1, async run(window, ctx) { … } }, // a record from settled prose; required by `decision`
  },
  advance: {
    async run(input, ctx) { … },                     // the Box's live content for a Generation: { items, allowance?, trace?, record? }
    trace: schema,                                   // checks the returned trace
    fingerprint(input) { … },                        // replaces dependencies in the preview fingerprint
    withoutBlock(input) { … },                       // captures the Box while its preset block is disabled
  },
  status(setup, state) { … },                        // the dock line; digesting Boxes only
  read(database, conversationId) { … },              // the window's JSON; non-digesting Boxes only
  remove(db, conversationId) { … },                  // deletes Chat data kept outside the data scopes
} satisfies Box<Setup, Dependencies, Trace, Services, Rec, State, Move>;

// 3. Client window: the `boxWindows` entry in src/client/box-windows/registry.tsx, only for a Box with a window
"<id>": { icon, size, Panel, DockTab, lens },        // lucide icon, { width, height } in rem, window body, minimized tab, optional lens
"<id>": digestWindow("<id>", { icon, size, Panel, describe }), // a digesting Box: optional Panel, then the passage timeline; a status dock tab
```

Every server hook is optional, as are the descriptor keys marked optional. The type checker enforces each "required by" pair and each "only". `Box`'s type parameters default to `Dependencies = undefined`, `Trace = never`, `Services = never`, `Rec = never`, `State = undefined` and `Move = never`; `Setup` is `undefined` without a `setup` key, so the Thoughts Box is `satisfies Box<undefined>`.

## The rules

- **Records are resolved values.** State is the fold of each selected Variant's effective record, in Message order, from `records.initial`. Selecting an earlier Variant, editing it or overriding it never re-evaluates, invalidates or drops a later record. A swipe reuses the Moves and seed of the Variant it replaces, and the same setup, state, Moves, seed and other dependencies give the same outcome, so a swipe with nothing else changed rewrites only the prose. A re-roll keeps the Moves and draws a fresh seed, so it can draw a new outcome. See [`records`](#record-and-records).
- **Each Box is absent, enabled or disabled in each Chat.** Only an enabled Box runs. Each insert starts a new instance, and the fold reads only the current instance's records, so a reinserted Box starts fresh. See [Lifecycle per Chat](#lifecycle-per-chat).
- **Box data lives in six storage scopes under the `box:<id>` namespace.** Boxes cannot add tables. A Box's own data never reaches another Box's namespace. The host's own per-Box values, such as the Decision Model selection, live outside it under `box-decision`. See [Storage](#storage).
- **A Box reaches the host only through the SDK.** A file in `src/boxes/<id>/` imports its own folder, packages, and its layer's entries in `src/box-sdk/`. Elsewhere in `src/`, only the three registrations and tests import a Box. The `ditzy/no-box-boundary-imports` lint enforces both directions. See [Folder and SDK](#folder-and-sdk).
- **Boxes compose only through the Prompt Plan.** Every Box advances in parallel and never sees another Box's result from the same Generation.
- **Writer overrides overlay automatic records.** The effective record is `writer ?? automatic`. An override never rewrites prose, a later automatic result never displaces it, and reset removes it.

## Add a Box

The host finds every hook through the registrations, so adding a Box edits no host file except an SDK entry that lacks an export. If a Box needs more, the host is missing a generalization: raise it instead of adding a special case. Run heavy commands through `flock /tmp/ditzy-heavy.lock`.

1. **Pick the hooks.** From [the contract](#the-contract), choose the descriptor keys and hooks the Box needs. The descriptor keys decide which server hooks the type checker demands. Done when you can name each one.
2. **Create the folder.** Make `src/boxes/<id>/` with files named by layer ([Folder and SDK](#folder-and-sdk)). Schemas go in `contract.ts`, or `shared.ts` for a small Box such as Thoughts or Mood. Logic both the server and the client use goes in `shared.ts`. Done when `bun run lint` and `bun run check:contracts` pass.
3. **Register it.** Add the id to `boxIds` and its `boxDescriptors` entry. Write `server.ts` exporting `<id>Box` that `satisfies Box<…>`, and add it to `serverBox`. Do all three before checking: `serverBox` is typed over every id in `boxIds`, and each entry is checked against its own descriptor's schemas and keys. Done when `bun run typecheck` passes.
4. **Add the window**, if the Box has one. Write `client.tsx` and add the `boxWindows` entry. A digesting Box always needs the entry, because it is what gives the Box its window and dock tab. It needs no window file when it has no setup and the generic record summary reads well: the entry is just `digestWindow("<id>", { icon, size })`, as for Mood. Done when `bun run typecheck` passes.
5. **Test it.** Write `e2e/<id>.spec.ts` with one test per user flow, asserting through Prompt Plan inspection. Inserting the Box adds its block to the Chat's preset. Insert it with `insertBox(page, "<label>")` from `e2e/fixtures.ts`. A digesting Box also needs `selectBoxDecisionModel(request, "<id>")` and scripted `llm.decisions(…)`. Digests also read the human's Messages, and the first matching rule wins, so end with a catch-all rule after the passage-specific ones (`e2e/world-clock.spec.ts`). Add unit tests only for logic that can really fail, such as a parser on malformed markup, determinism for a seed, or a fold. Write no UI component tests and no tests of the contract's shape. Done when `bun run check` and `bun run test:e2e` pass.

## Hooks

### `label`, `role`, `startsEnabled`, `instructions`, `alwaysRender`

| Key | The host uses it for |
|---|---|
| `label` | the preset block label, the add-block menu, the Box manager, the window title, the dock tab and the Decision Model setting's name |
| `role` | the outgoing role of the Box's preset block (`system`, `user` or `assistant`) until an author changes it |
| `startsEnabled` | `defaultBoxIds`: the Boxes a new Chat starts with |
| `instructions` | the text a new [preset block](#preset-block) starts with, and what its Reset action restores |
| `alwaysRender` | renders the block when `advance` returns no items, for a Box whose instructions are its whole contribution |

The id itself is the entry in `boxIds`, not a field.

Put fixed teaching and framing in `instructions` and only live data in `advance`'s items, so an author can rewrite the wording and the Box never repeats it. Instructions are authored preset text: the [Prompt Macro](../../GLOSSARY.md) pass expands them with `{{self}}` as the human-controlled Participant and `{{other}}` as the model-controlled one.

### `setup` and `setupError`

Per-Chat configuration, declared as `setupOf(schema, initial)`. The host stores it in `conversation_data` under key `setup`. A Chat with no stored setup reads `initial`. The Chat summary carries every setup as `conversation.boxSetups[<id>]`.

A Panel saves a whole new setup with `{ type: "set-box-setup", box, setup, writes? }`. Use `useBoxSetupDraft("<id>", { conversation, disabled, onConversationChange, conflict, valid?, onSaved?, extra? })` from the client SDK, as the Author Note, World Clock and Race do. It holds the draft against the saved setup and its expected revision, and saves with `save(setup?, writes?)`. On a conflict it keeps the draft and loads the current saved setup beside it. It registers the window's SaveGuard; `extra` adds further unsaved work, such as the Race's open stat sheet, that the guard saves or discards with the draft.

The command accepts a Box that is present in the Chat, enabled or disabled, and checks the value against the schema. An absent Box takes no setup, so nothing saved before an insert survives into it. `writes` are the Box's own data writes, each `{ owner, key, value }` as in [`put-box-data`](#storage), that must land with the setup or not at all. They pass the `put-box-data` checks in the setup's transaction, so one refused write commits neither the setup nor any other write.

`setupError(setup, previous)` rejects a setup the schema accepts but the Box does not. Its message fails the command and shows in the window.

### `moves` and `moves.render`

Actions the writer attaches to a Human-authored Message, declared as `movesOf(schema, max, label)`. `max` bounds the Moves per Message, and `label(move)` is the chip text. `seatBound: true` ties staged Moves to the human seat ([Move staging](#move-staging)). The server Box must declare `render(move, author)`.

The host stores each Box's Moves in order in `messages_data` under key `moves`. For the Generation prompt, Lore scanning and Generation-time Memory recall, the Message's text becomes each Move's `render`, one per line, then the prose. Digests and background Memory extraction read the raw prose. While the Box is not enabled, the host uses the Move's chip label instead of `render`, so a removed Box never breaks past Messages. [Move staging](#move-staging) covers the composer.

Validate staged Moves with the same function the Box resolves them with, kept in `shared.ts`. A Move that was legal when staged may fizzle at resolution, and the Box narrates the failure.

### `record` and `records`

`record` is the `Type.Object` schema of one Variant's record. An object, so an absent record is never confused with a record's value. The server Box must declare `records: { initial, fold }`. State is never stored: the host folds it whenever it needs it.

Records come from two places: `advance` returns one at Generation time (the Race), or `records.digest` reads settled prose later (World Clock, Mood). Any Box with a `record` accepts Writer overrides through `set-box-record` and `reset-box-record`. Only digesting Boxes get an editor for them, in the [passage timeline](#passage-timeline). An override is refused while its Variant is still generating.

Pick the record's granularity by what an upstream change should do to it:

- **Facts about the passage**, when an earlier change should shift the result. The World Clock stores elapsed minutes and weather, so editing an earlier passage's duration moves every later time.
- **The whole resulting state**, when a step is only meaningful from the exact state it ran on. The Race stores the post-Stretch state, and its fold returns it. An earlier change never replays later Stretches.

### `decision`, `records.digest` and `status`

`decision` makes the Box a digesting Box: the server Box must declare `records.digest`, and may declare `status` but not `read`. That one key gives the Box the [digest queue and catch-up](#digest-queue-and-catch-up), the [passage timeline](#passage-timeline) as its window read, and a global Decision Model selection in Connection Settings, worded by the four `decision` strings. The host stores the selection (profile, model and state token limit) in `library_data` under its own `box-decision` namespace, keyed by the Box id. Without a selection no digest runs.

`digest.run(window, ctx)` returns one record for one selected passage. `window` is `{ passage, preceding, seed, cast, data }`. `passage` and each `preceding` entry are `{ messageId, speaker, authorId, content }`; `authorId` is the authoring Participant's id, or `null`. `preceding` holds up to `digest.window` selected Messages before the passage, oldest first. `seed` is this Box's stream of the Variant's seed. `cast` is every Participant in the Chat as `{ id, name, removed }`, removed ones included so every author resolves. `data` is the Box's own `box:<id>` `conversation_data` values by key, as stored strings. A Box that should not digest a passage, such as one by an author it ignores, returns an empty record. `ctx` holds the services the Box [injects](#inject), and `ctx.signal` aborts when the job is superseded or cancelled.

`ctx.decide(state, questions)` is always present and asks the Box's own Decision Model selection, replacing the injected `decide`. The host packs the request and throws if `state` exceeds the selection's token limit. Questions are keyed by name, and the answers come back as a `Map` with the same keys. A `choice` question names its options as `criteria` keys:

```ts
const answers = await ctx.decide({ passage, preceding }, {
  mood: { type: "choice", instructions: { question: "What mood does `passage` leave the scene in?" }, criteria: { calm: "…", tense: "…" } },
});
const answer = answers.get("mood"); // { type: "choice", choice: "tense", … }
```

Throw on an answer outside your options. A thrown error is logged and written to the slot's `error` with the hash of the text it failed on; it leaves the slot's records alone. The host checks a returned record against the `record` schema and writes it as the slot's `automatic` value with the hash of the digested text.

`status(setup, state)` is the dock tab's line, or `null` to show the label. The host calls it with the state folded over every selected record, the same state Generation capture folds. The dock tab's accessible name is `<label>: <status>`, which is how an e2e test finds it.

### `advance`

The Box's turn in a Generation: Send, Continuation, Sibling and Prompt Plan preview alike. `run(input, ctx)` gets `input = { setup, dependencies, state, moves }`. `moves` are the ones on the triggering Human-authored Message: the one sent, or the one a Sibling answers. A Continuation has none, and neither does a Sibling of a Message that follows the model's own.

It returns `{ items, allowance?, trace?, record? }`:

- `items` are `{ text, priority, pinned?, literal? }`. [Admission](#generation-lifecycle) places them in the Box's block after its instructions. A `literal` item skips the Prompt Macro pass; Memory marks recalled claims literal so a stored claim never runs a macro. An empty list leaves the whole block out, instructions included, unless the descriptor declares `alwaysRender`. A Box without `advance` returns an empty list.
- `allowance` caps the unpinned items' tokens.
- `record` is checked against the descriptor's `record` and written to the new Variant as the slot's `automatic` value when the Variant resolves. Returning a record without a `record` descriptor throws.
- `trace` is checked against `advance.trace` when declared. Only Memory's trace has a consumer: it becomes the Generation's Memory activation record.

`fingerprint(input)` replaces `dependencies` in the [preview fingerprint](#generation-lifecycle). Declare it only when the dependencies do not serialize to what should mark a preview stale. Only Memory declares it.

`withoutBlock(input)` captures the Box while its preset block is disabled, returning this result instead of calling `run`. Only Memory declares it, to record activation evidence with no items.

### `dependencies`

Inputs `advance` needs beyond setup, state and Moves. The host calls `dependencies(read, setup)` at capture and passes the result as `input.dependencies`; without the hook it is `undefined`. `read` is the `CaptureRead`:

| Field | Value |
|---|---|
| `seed` | this Box's stream of the Variant's seed |
| `intent` | `"continue"` for a Continuation and for a Sibling whose preceding Message the model wrote; otherwise `"respond"` |
| `human` | the human-controlled Participant's `{ id, name }` |
| `cast` | every Cast member's `{ id, name }` |
| `memory()` | Memory's recall snapshot; only Memory calls it |

### `inject`

The provider services `advance.run` and `digest.run` receive on `ctx`: `llm`, `decide` and `embed`. The host builds `ctx` from exactly the declared keys, plus `signal`, which aborts when the server shuts down or, in a digest, when the job is superseded or cancelled. A digest's `decide` is always its own [Decision Model selection](#decision-recordsdigest-and-status).

### `read`

The window's data for a non-digesting Box, served at `GET /api/conversations/:id/boxes/<id>`. Return JSON, or `undefined` for a missing Chat, which the route answers with 404. Read inside `runConversationReadTransaction`, using `readSelectedHistoryFromConnection` for the Selected path. Send only what the writer may see: the Race read holds back its replay and Hidden intents until the finish.

Declare the read schema in `contract.ts` or `shared.ts`, decode it on the client, and key the query by `conversation.revision` so it refetches when the Chat changes:

```ts
foundOrNull(await requestOutcome(api.api.conversations({ id }).boxes({ box: "<id>" }).get({ fetch: { signal } }), <id>Read, notFoundOutcome))
```

### `remove`

Deletes Chat-scoped data the Box keeps outside `conversation_data` and `participant_data` when the writer removes it. The host calls it inside the removal transaction, after deleting those two.

### Window entry

`icon` is a `lucide-react` icon for the launcher, the window bar and the generic dock tab. `size` is `{ width, height }` in rem. `Panel` gets:

| Prop | Use |
|---|---|
| `conversation` | the `ConversationSummary`, with `boxSetups`, `boxes`, `cast`, `control` and `revision` |
| `disabled` | true while a Prompt Plan preview is open or a Generation is assembling; disable every control that sends a command |
| `staging` | the composer's staged Moves: read `staging.moves[<id>]`, write with `staging.onChange({ ...staging.moves, <id>: [...staged, move] })` |
| `boxData` | `boxData(owner, key, value)` builds a `put-box-data` command for this Box |
| `onConversationChange` | pass to `runConversationCommand` so the Chat summary updates |

`DockTab` gets `conversation` and `onRestore`. Render a `<button type="button" className="box-dock-tab">` with the icon, an `sr-only` label and one short line, as `ThoughtDockTab` does.

A digesting Box builds its entry with `digestWindow`, which supplies the `Panel` (the Box's own `Panel`, if any, then the passage timeline) and a `DockTab` showing `status`. `describe(record)` replaces the timeline's generic record summary; it takes the Box's own record type.

### `lens`

Lifts the Box's markup out of the story view, leaving a mark that opens the window. The prompt keeps the markup. Build it with `lens(tag, gate, strip, View)` in `registry.tsx`:

| Argument | Contract |
|---|---|
| `tag` | the markup tag, such as `"thought"` for `<thought>…</thought>` |
| `gate(conversation)` | a context value, or `undefined` when nothing should be lifted in this Chat |
| `strip(text, context)` | splits prose into `{ kind: "prose", text }` and `{ kind: tag, text }` segments, in order |
| `View` | renders one lifted segment from `{ text, onOpen }`; `onOpen` opens the window |

`strip` is also the parser the window `read` uses to list what was lifted, so it is one function in `shared.ts`. Malformed markup stays raw text. Unit-test it on malformed and nested input. [The lens pipeline](#lens-pipeline) describes how lenses combine.

## Host mechanics

### Folder and SDK

Each file in `src/boxes/<id>/` takes its layer from its name. A layer with several files prefixes each name, such as `server-engine.ts`, `shared-data.ts` or `client-oval.tsx`. Tests sit beside the file they test.

| File | Layer | Holds | May import from the host |
|---|---|---|---|
| `contract*.ts` | shared | TypeBox schemas and their types | `src/box-sdk/shared.ts` |
| `shared*.ts` | shared | logic the server and client both use | `src/box-sdk/shared.ts` |
| `server*.ts` | server | the server Box | `src/box-sdk/server.ts`, `src/box-sdk/shared.ts` |
| `client*.ts(x)` | client | the Panel, DockTab and lens View | `src/box-sdk/client.ts`, `src/box-sdk/shared.ts` |

The layer rules read Box file names too: a `client*` file imports `server*` code only for types, a `shared*` or `contract*` file imports neither, and a `Type.Object` in a `server*` or `client*` file fails `check:contracts`. The SDK entries re-export only what the built-in Boxes use; read them for the list. When a Box needs something else from the host, add it to its layer's entry.

### Storage

| Scope | Table | Written by |
|---|---|---|
| Library | `library_data (namespace, key, value)` | the window, through `put-box-data` |
| Character | `character_data (character_id, namespace, key, value)` | the window, through `put-box-data` |
| Participant | `participant_data (participant_id, namespace, key, value)` | copied from Character data when a Character seeds a Participant; then the window, through `put-box-data` |
| Conversation | `conversation_data` | the host: `enabled`, `instance`, `setup` |
| Message | `messages_data` | the host: `moves` |
| Variant | `message_variant_data` | the host: `record:<instance>` slots |

`put-box-data` takes the Box id, not a namespace, and the Panel's `boxData` prop fixes it, so no window can name another Box's namespace. The host rejects it for a Box not enabled in the Chat and for an owner that does not exist. Library and Character writes carry the value's revision as last read (0 when absent), because the Chat revision cannot guard values shared across Chats. Values are strings the Box decodes; a value that fails its schema is an error, never a row to skip. Character and Participant data are independent after the copy.

A record slot is `{ automatic?, writer?, source?, error? }`, keyed by the instance that wrote it. `source` hashes the digested text, so an edit is digested again and a reselection is not. `error` is `{ source, message }`, the last failed digest and the hash of the text it failed on. Each Variant also holds one Generation seed shared by every Box, under namespace `box`, key `seed`. A Box's stream hashes it with the Box id. A Variant with no seed, such as an imported one, uses `variant:<id>`.

Setups, records, Moves and Decision Model selections are decoded against their schemas on every read, and commands check them before they land. There is no migration path: a stored value that fails to decode after a schema change is an error naming the namespace or key to clear. A feature that needs relational queries stays in-tree code that owns its tables, like Lorebooks and Memory's collections.

### Lifecycle per Chat

The host stores `enabled: true | false` and an `instance` id in `conversation_data`. No row means absent. Server code reads it with `isBoxEnabled` or `readBoxStates` in `src/server/box/setup.ts`; client code reads `conversation.boxes[<id>]`.

| State | Runs | Keeps |
|---|---|---|
| enabled | [captured](#generation-lifecycle) into Generations, digests, accepts Moves and `put-box-data`, shows its launcher, window, dock tab and lens | everything |
| disabled | nothing; re-enabling picks up where it left off | setup, data, instance |
| absent | nothing | Library and Character data, Variant records and Message Moves |

Removing, after confirmation in the Box manager, deletes the Box's `conversation_data` (its instance included), this Chat's `participant_data` in its namespace, and whatever `remove` deletes. Each insert creates a new instance; disabling keeps it. The fold reads only the current instance's slots, so a reinserted Box starts from `setup.initial` and `records.initial` while its old records stay stored. A Box writes no filter for this. One Chat holds at most one instance of each Box.

Turning a Box on, at creation or later, adds its [preset block](#preset-block) when the Chat's preset has none. Disabling or removing reports `stoppedBox` on the Conversation change. The digest queue drops that Box's jobs and aborts those in flight; a Box with other background work cancels it on `stoppedBox`, as `src/server/memory/sync.ts` does. A new Chat starts with the `startsEnabled` Boxes, today the Author Note and Memory. No Box is exempt from removal. The writer manages Boxes in the composer's Box manager.

### Generation lifecycle

1. **Capture.** For each enabled Box whose preset block is enabled (or that declares `withoutBlock`), the host reads its setup, its folded state, the Moves, and its `dependencies`. A swipe reuses the seed of the Variant selected at its Message; every other Generation, re-roll included, gets a new one.
2. **Advance.** Records and traces are held on the Active Generation with the captured instance and copied to the Variant when it resolves.
3. **Admission and budget.** The block's instructions and its items pass through the Prompt Macro pass, except literal items. Pinned items are admitted first, ignore the allowance, and count toward the context limit. Then each unpinned item, by descending `priority`, is admitted whole if it fits both `allowance` (or the remaining context when none is given) and the context limit. `allowance` counts items only; the instructions count toward the context limit. The block renders its instructions, a newline, then the admitted items in that order, separated by blank lines. A plan that still overflows the context, pinned items included, raises `PromptBudgetExceededError`. Per-item admission reasons reach inspection only for Memory.
4. **Preview fingerprint.** The host fingerprints the whole preparation snapshot, seed included, with each Box's setup, state, Moves and `dependencies` (or its `fingerprint`). Sending from a preview reuses that capture and sends the inspected plan without advancing any Box again; if the fingerprint changed meanwhile, the Send fails with "The Prompt Plan is stale. Refresh it before sending."
5. **Digest.** Resolution queues the Variant's [digests](#digest-queue-and-catch-up). Generations never wait for digests, and a finished Variant keeps the inputs it was generated with: a digest that lands later changes only what the next Generation folds.

### Preset block

Each Box has at most one block per preset, reference `box:<id>`, labelled and given its starting role by the descriptor; a partial unique index on `(preset_id, reference)` holds that. The block's `content` is its instructions. Every new block, from the add-block action or from turning a Box on, copies the descriptor's `instructions`; from then on the text belongs to the preset, and changing the descriptor never rewrites an existing block. The preset editor shows the instructions as an editable text area, a read-only line marking where the Box's content goes, and **Reset to <Label> default**, which restores the descriptor's text into the draft. A block renders nothing when its Box is not captured, or when `advance` returns no items and the descriptor has no `alwaysRender`, so instructions never reach the prompt without the content they introduce. The add-block menu lists every Box. The block constraints accept any `box:` reference, so a new Box needs no migration. A Box On in a Chat whose preset lacks its block gets one, placed right after the last history block with the descriptor's role, exactly as the add-block action places it: `installBoxBlocks` in `src/server/prompt-preset/blocks.ts` runs in the same transaction as creating a Chat and as turning a Box on. Presets are shared and a block produces output in every Chat where its Box is On, so another Chat on the same preset with that Box On starts sending it too. A block that exists stays as the author left it: a disabled block stays disabled, and the Box manager row and the Box's window say "<Label> block is off in <preset>" with an Enable action. A Chat that switches to a preset without the block, or whose block an author deletes, gets the same notice with Add block. The preset decides where a Box goes; the Chat decides whether it runs.

### Digest queue and catch-up

The host queues a digest for a selected, settled, non-empty Variant when it resolves, when it becomes selected without a record for its current text, or when its text is edited. Two workers drain the queue, live jobs before catch-up jobs. Each Variant and Box has one current job: a newer one aborts the older, and only the current job's result lands. A result, or a failure, is discarded if the text changed, the job was replaced or cancelled, the Box stopped being enabled, or the Decision Model selection went away. A failed digest is not queued again for the same text; an edit queues it, and so does catch-up. A successful digest clears the slot's `error`. Jobs live in memory; work lost on restart is queued again on the next selection, resolution or edit, or by catch-up.

Catch-up queues every selected Variant without a record for its current text, failed ones included, behind live work. The window shows its progress, with how many failed, and can cancel it. A second request while one runs does nothing.

### Passage timeline

`src/client/box-windows/PassageTimeline.tsx` ends every digesting Box's window. It lists the Selected path's non-empty passages, each with its effective record (or "Not read yet"), an "Overridden" mark, a "Digest failed" mark carrying the error when the last digest of its current text failed, Edit and Reset. "Digest missing passages" starts catch-up. Without a Decision Model selection it tells the writer to pick one in Connection Settings. It polls while open, faster during catch-up; a minimized dock tab polls only the status.

The override editor is built from the `record` schema:

| Field schema | Editor |
|---|---|
| a union of `Type.Literal`s, optionally with `Type.Null()` | a select, one option per member |
| `Type.Integer()` or `Type.Number()` | a number input bounded by `minimum` and `maximum` |
| `Type.String()` | a text input |

Any other field type, and any `Type.Optional` field, throws when `digestWindow` builds the entry, so the client fails at load. A field that may be unset is a union of literals with `Type.Null()`. The union's members must type as a fixed tuple: write each literal out, or cast a mapped array to a tuple type as the World Clock's `weatherSchemas` does. A spread of a plain `names.map(Type.Literal)` typechecks on the server but collapses the `set-box-record` route type on the client. Each schema's `title` labels its field or option, such as `Type.Literal("rain", { title: "🌧️ Rain" })`; without one the key or value shows, and `null` shows as "None". A new draft starts a nullable choice at `null` and leaves other fields empty. Save stays disabled until the draft passes the schema.

The generic summary joins the fields with ` · `: a choice shows its option's title, a number or string its value, and a `null` field nothing. A Panel that changes something `status` depends on, such as setup, refreshes the timeline with `client.invalidateQueries({ queryKey: boxDigestKey(conversation.id, "<id>") })`, or passes that as `onSaved` to `useBoxSetupDraft`.

### Lens pipeline

The story view applies the lens of each enabled Box whose `gate` returns a value, in `boxIds` order, each to the prose the earlier ones left. A lifted piece is never lensed again. While a Message streams, an unclosed `<tag` is hidden instead of flashing as raw markup.

### Move staging

A Panel stages Moves through `staging`. They show as chips above the composer text, which the writer can drag to reorder or remove. A Message may hold only Moves. In the story, a Message shows its Moves as chips.

A Send with Moves for a Box that is not enabled is rejected. The composer drops staged Moves for a Box that stops being enabled, and seat-bound ones when the human seat changes. A Send that retries an existing Human-authored Message keeps the Moves already stored on it. `set-message-moves` replaces a past Message's Moves, but not while a Generation runs; regenerating its reply replays the turn.

### Windows and dock

The composer shows a launcher button for each enabled Box with a window entry. Windows drag but do not resize, several can be open at once, and Escape closes one. Minimizing turns a window into its dock tab, at the bottom-right beside the composer. Open state, minimization and position are client-side, per Chat, in local storage. Below 78rem wide, the top window becomes a full-screen layer with focus trapped inside.

The host styles the frame, the dock and the passage timeline in `src/styles/box-windows.css`. A Box adds no stylesheet: style the Panel with Tailwind utilities and the shadcn components the client SDK re-exports, as `src/boxes/thought/client.tsx` does (`text-muted-foreground`, `bg-muted`, `rounded-xl`, `font-(family-name:--font-reading)` for story text). The World Clock and Race windows still use classes in `box-windows.css` from before the host was generic; do not copy that. Follow `DESIGN.md` for visual decisions.

## Built-in Boxes

| Box | Starts enabled | Declares |
|---|---|---|
| Author Note | yes | `setup`, `advance` |
| Memory | yes | `inject: ["decide", "embed"]`, `dependencies`, `advance` with `trace`, `fingerprint`, `withoutBlock`; `remove` |
| World Clock | no | `setup`, `record`, `decision`, `setupError`, `records.digest`, `advance`, `status`; `digestWindow` with `Panel` and `describe` |
| Race | no | `setup`, `record`, `moves`, `setupError`, `dependencies`, `records`, `advance`, `read`; window |
| Phone | no | `instructions`, `moves` (seat-bound), `dependencies`, `advance`, `read`; window and lens |
| Thoughts | no | `instructions`, `alwaysRender`, `read`; window and lens |
| Mood | no | `instructions`, `record`, `decision`, `records.digest`, `advance`, `status`; `digestWindow` alone |

**Author Note.** Setup is the note text, Image References included. `advance` returns it as one pinned item, or nothing when blank. It has no instructions. Lore scanning, Semantic Trigger judging and Memory extraction never read it. It edits in the workspace's primary panel, not a Box window.

**Memory.** It has no instructions. A seam port: `advance` is recall (capture, embedding query, Decision Model relevance), returning literal claims prioritized by relevance under Memory's allowance, and its activation record as the trace. `fingerprint` is the recall snapshot's freshness fingerprint. Memory keeps `memory_collection`, its settings tables and its extraction queue in-tree; `remove` deletes the per-Chat settings row. It keeps its own side panel. The full port onto records and digests is [#68](https://github.com/TanJeeSchuan/DitzyTavern/issues/68).

**World Clock.** Setup is a naive Gregorian start (`YYYY-MM-DDTHH:mm`; `setupError` rejects dates such as February 31), an era suffix (default `AD`), a climate (temperate, tropical, arid, cold), a hemisphere and a unit (default °C). A digest reads the passage with one preceding Message and asks two `choice` questions: the elapsed time (`none`, `~5m`, `~15m`, `~30m`, `~1h`, `~2h`, `~4h`, `~8h`, `overnight`, `~1 day`, `several days`), with the exact minutes drawn inside the bin from `seed`; and the weather established (`not mentioned`, `clear`, `cloudy`, `rain`, `storm`, `snow`, `fog`). The record is `{ minutes, weather }`. The fold adds minutes and keeps the latest weather with the minute it was mentioned; the clock stops showing it 24 in-world hours after that. Temperature follows climate, hemisphere, season, hour and weather. It has no instructions: `advance` pins one line, `8:41 AM | 🗓️ Saturday, December 20, 2025 AD | ☀️ Clear, 3°C`, omitting unknown weather; without a Decision Model selection the clock stays where it is. Status is `8:41 AM · ☀️ 3°C`.

**Phone.** Texts live in the prose as `<sms from="…" to="…">…</sms>`. The instructions teach the markup, with `{{other}}` texting `{{self}}` as the example. `advance` pins one line naming the human's contacts (the other Cast members), `Night Desk has a phone and can text Theodora Kline.`, or nothing when there is nobody to text, which also drops the instructions. Outgoing texts are seat-bound Moves rendered as `<sms>` from the Message's author, so a texting-only turn is a Moves-only Message. The lens lifts a text only when one end is the human-controlled Participant and the other a Cast member, matching names case-insensitively. The read groups texts, the human's sent Moves included, into one thread per contact. Unread counts are client-side view state, never in the prompt; the dock tab shows `2 unread`.

**Thoughts.** The instructions ask for unspoken thoughts as `<thought>…</thought>`. It has no `advance` and declares `alwaysRender`, so its block is the instructions alone. The lens lifts every thought, and the read lists them along the Selected path. In nested markup only the innermost pair matches. The dock tab counts thoughts.

**Mood.** A digest asks one `choice` question over the passage and one preceding Message: `not clear`, `calm`, `warm`, `playful`, `tense`, `sad` or `eerie`. "Not clear" keeps the previous mood. The instructions are `Scene mood:` and `advance` pins the mood, `tense`, so the block reads `Scene mood:` then `tense` on the next line. Status shows the emote and word, `😬 tense`. It has no window file: the generic timeline and dock tab are its whole window.

### Worked example: the Race

The Race uses most of the contract. Its files in `src/boxes/race/`: `server.ts` (the Box), `server-engine.ts` (the simulation), `server-cast.ts` (Cast stats), `contract.ts` (schemas), `shared.ts` (Move rules for both window and engine), `shared-data.ts` (bundled courses, roster, seeded random) and the `client*` files (the window).

```ts
race: {
  label: "Race", role: "system", startsEnabled: false, instructions: "",
  setup: setupOf(raceSetup, initialRaceSetup),
  record: raceRecord,
  moves: movesOf(raceMove, MAX_RACE_MOVES, raceMoveLabel),
},
```

```ts
satisfies Box<RaceSetup, Pick<RaceInput, "seed" | "intent" | "withdrawn">, never, never, RaceRecord, RaceState | null, RaceMove>
```

It has no trace and no injected services. It has no `decision`, so it does not digest, serves its own `read`, and gets no override editor; its slots hold only `automatic` in practice.

**Setup.** `raceId`, the course (one of eight bundled courses, or a custom distance, surface and direction), metres per Stretch, up to 18 slots, Auto mode (`off`, `on`, `{ until }`) and `phase` (`setup` or `running`). Whether the race finished is folded state. "Start race" saves the draft with a new `raceId` and `phase: "running"`; "New race" saves `initialRaceSetup` with another new `raceId`. `setupError` rejects course or field changes once a race is running, an Auto stop beyond the course, two gates with one name, and a running race without an id or two Runners.

**Field.** Slots are Cast members plus roster Runners drawn by "Fill field" with seeded stats biased by Running style. A roster Runner sharing a Cast member's name is excluded. Stats are Speed, Stamina, Power, Guts and Wit, plus a Running style (Front Runner, Pace Chaser, Late Surger, End Closer, named as in the game's English localization so "Runner" stays free for entrants). A Cast Runner's stats are its Participant's, copied from its Character on seeding and edited by the writer afterwards; slotting one without stats opens a stat sheet to roll or set them, which can save back to the Character. The repository ships no Runner art: `bun run db:seed:race-avatars` loads roster avatars from the gitignored `race-avatars/` folder, or the writer sets one in the window.

**Dependencies.**

```ts
dependencies: ({ seed, intent, cast }, setup) => ({
  seed, intent, withdrawn: setup.slots.flatMap(({ name, participantId }) => participantId !== undefined && !cast.some(({ id }) => id === participantId) ? [name] : []),
}),
```

`withdrawn` lists slotted Cast Runners whose Participant has left the Cast. The Race declares no `fingerprint`: the default fingerprints these dependencies, so a new seed or withdrawal marks a preview stale.

**Records and fold.** A record is `{ raceId, stretch, outcome, after }`, where `after` is the full post-Stretch state: standings, energy, Hidden intents and the replay so far. `foldRace` returns `after` when it belongs to the current `raceId`, so old races never leak into a new one, and `currentRaceState` treats state from another `raceId` as initial.

**Advance.** `advanceRace` is a pure function of setup, state, Moves, seed and intent; all randomness comes from `raceRandom(seed)`, so equal inputs, withdrawals included, repeat the outcome. One call:

1. Returns nothing unless the race is running with at least two Runners. A continue intent advances only under Auto, and `{ until }` stops it `until` metres before the finish.
2. Resolves the writer's Moves in order with `checkRaceMove`, so a Move that turned illegal fizzles with its reason.
3. Has the engine decide for every other Runner from Running style, stats, energy and position, across four phases: opening, middle, final corner and last spurt.
4. Simulates the Stretch in 20 fixed steps. Stretches shorten to at most 100 m in the final 400 m.
5. Picks two or three salient events, scored double for Cast Runners, plus foreshadowing and reveals for Hidden intents.
6. Writes the item: course, Stretch range, standings, events, Move results, intents and "Narrate only this Stretch. Do not go past N m."

The Race has no instructions: every line of its item changes per race or per Stretch, and the closing line differs between a Stretch, a Hold and the finish.

Once the field crosses the line, one Results Stretch gives finishing order, margins and outstanding reveals, with "Narrate the finish." After it the Race returns nothing until a new race.

`raceBox.advance.run` wraps that for Hold and withdrawal. A lone legal Hold on a respond turn returns a pinned item and no record, so the race stands still. A withdrawal is announced once and persisted as a record even when no Stretch runs, so it does not repeat on every Hold. A field cut below two Runners ends in a walkover. Every item is pinned at priority 100: a Stretch reaches the model whole or not at all.

**Moves.** Overtake, Conserve, Spurt and Hold, each acting on the human seat's Runner, or as an order to a chosen Runner when the human seat is not racing. The window offers each legal Move with its projected cost and odds from `checkRaceMove(setup, state, staged, move)`. Moves are off while Auto advances the race: always under `on`, and until `until` metres before the finish under `{ until }`. `render` gives `(Race Move: Special Week tries to overtake.)`; once the Race is not enabled, history shows the chip `⚡ Overtake · Special Week`.

**Data scopes.** Library: roster avatars, keyed `avatar:<name>`, written through `boxData`. Character and Participant: `stats`. A stat sheet's `stats` ride as `writes` on the `set-box-setup` that adds the gate, so the gate and its stats land together. `readRaceCastStats` decodes Participant stats and fails loudly on a bad row.

**Window.** `RacePanel` shows setup and stat sheets before the start, the SVG oval (Portraits for Cast Runners, roster avatars otherwise) and Move controls while running, and a replay of every Runner's decisions per Stretch after the finish. `readRace` sends the spectator state and a status line, `🏇 1500m · 3rd` while running or `🏁 1st · Special Week` when finished, which `RaceDockTab` shows.

**Tests.** `server-engine.test.ts` checks determinism for equal inputs and the fold across `raceId`s; `server-withdrawal.test.ts` covers withdrawals. `e2e/race*.spec.ts` starts a race, advances it with Moves, swipes for the same outcome and re-rolls for a new one, asserted through Prompt Plan inspection.
