# Authoring a trusted Box

This covers writing and installing a trusted Box, its hooks, and the SDK; start at the [Box system entry point](README.md).

## Add a Box

The host finds every Box by its folder, so adding a Box edits no host file except an SDK entry that lacks an export. If a Box needs more, the host is missing a generalization: raise it instead of adding a special case. Run heavy commands through `flock /tmp/ditzy-heavy.lock`.

1. **Pick the hooks.** From [the contract](README.md#the-contract), choose the descriptor keys and hooks the Box needs. The descriptor keys decide which server hooks the loader demands. Done when you can name each one.
2. **Create the folder.** Make `src/boxes/<id>/` with files named by layer ([Folder and SDK](#folder-and-sdk)). Schemas go in `contract.ts`, or `shared.ts` for a small Box such as Thoughts. Logic both the server and the client use goes in `shared.ts`. Done when `bun run lint` passes.
3. **Describe it.** Write `shared-descriptor.ts`, default-exporting the descriptor with the folder's name as its `id` and `sdk: 2`, and `server.ts`, default-exporting the Box that `satisfies Box<…>` with the types of your own schemas. The loader checks the Box's hooks against its descriptor's keys and refuses the Box with the reason in the server log, so every server test that reads it fails until they match. Done when `bun run typecheck` and the Box's server tests pass.
4. **Write the client module.** Every Box has a `client.tsx` that default-exports its descriptor, its icon and its client surfaces, such as its window. A digesting Box needs a window for its passage timeline and a `Status` line for the dock; Memory, which keeps its own inspector, has none. A digesting Box with no setup, whose generic record summary reads well, needs nothing else: its client module is `{ descriptor, ...digestWindow(descriptor, { icon, size }) }`. Done when `bun run typecheck` and `bun run build` pass.
5. **Test it.** Write `src/boxes/<id>/<flow>.spec.ts` with one test per user flow, asserting through Prompt Plan inspection. Inserting the Box adds its block to the Chat's preset. Insert it with `insertBox(page, "<label>")` from `e2e/fixtures.ts`. A digesting Box also needs `selectBoxDecisionModel(request, "<id>")` and scripted `llm.decisions(…)`. Digests also read the human's Messages, and the first matching rule wins, so end with a catch-all rule after the passage-specific ones (`src/boxes/world-clock/world-clock.spec.ts`). Add unit tests only for logic that can really fail, such as a parser on malformed markup, determinism for a seed, or a fold. Write no UI component tests and no tests of the contract's shape. Done when `bun run check` and `bun run test:e2e` pass.

## Install a plugin Box

A plugin is a Box folder installed into a running DitzyTavern without rebuilding it. It is written exactly as in [Add a Box](#add-a-box), except that it lives outside `src/boxes/`.

1. **Write it in a checkout.** Make the folder in a DitzyTavern checkout's `data/boxes/<id>/`, which git ignores and `bun run typecheck` includes. Under the checkout, `@/box-sdk/<entry>` resolves through its `tsconfig.json` and packages through its `node_modules`, for the server, the typecheck and the build alike. Set `sdk` to the `boxSdkVersion` the shared SDK exports, today `2`. Done when `bun run typecheck` passes.
2. **Build its client.** Run `bun run box:build data/boxes/<id>`. It builds `client.tsx` into `data/boxes/<id>/dist/client.js` as `bun run build` builds a built-in's ([Client modules](host.md#client-modules)): the host modules stay imports, anything else `client.tsx` imports, such as `lucide-react`, is bundled, and a stylesheet it imports becomes `dist/client.css`. The descriptor, contract, shared and server files ship as `.ts`, which Bun runs directly. Done when `dist/client.js` exists.
3. **Install it.** Copy the folder, `dist/` included, to the plugin folder: `data/boxes/<id>/` beside the app, `/app/data/boxes/<id>/` in [Docker](../docker.md). Restart the server. Done when the Box manager lists it with no `Did not load` line. The server log names a Box it refused and why ([Loading](host.md#loading) lists the rules), and a Box whose client module did not load shows `Did not load: <reason>` in its Box manager row.

`e2e/fixtures/boxes/tip-jar/` is a plugin with a window, a Move and a record. `e2e/box-plugin.spec.ts` installs it: the e2e global setup builds it with `box:build`, `llm.installBox("tip-jar")` copies it into the worker's plugin folder, and `llm.restart` loads it. The worker's plugin folder sits under the repository, in `.scratch/`, so the fixture's imports resolve, and each test starts with it empty.

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
| `instructions` | the text a new [preset block](host.md#preset-block) starts with, and what its Reset action restores |
| `alwaysRender` | renders the block when `advance` returns no items, for a Box whose instructions are its whole contribution |
| `block` | the preset editor's `{ description, source }` for the block, in place of "Uses the `<label>` Box when it is enabled in this Chat." from "This Chat" |

Put fixed teaching and framing in `instructions` and only live data in `advance`'s items, so an author can rewrite the wording and the Box never repeats it. Instructions are authored preset text: the [Prompt Macro](../../GLOSSARY.md) pass expands them with `{{self}}` as the human-controlled Participant and `{{other}}` as the model-controlled one.

### `setup` and `setupError`

Per-Chat configuration, declared as `describeSetup(schema, initial)` from the shared SDK. The host stores it in `conversation_data` under key `setup`. A Chat with no stored setup reads `initial`. The Chat summary carries every setup in `conversation.boxSetups` as a `BoxValue`. Read your own with `boxSetupOf(conversation, "<id>", schema)` from the shared SDK, which checks it against your schema and types it, as the Race does.

A Panel saves a whole new setup with `{ type: "set-box-setup", box, setup }`. Use `useBoxSetupDraft("<id>", schema, { conversation, disabled, onConversationChange, conflict, valid?, onSaved?, extra? })` from the client SDK, as the Author Note, World Clock and Race do. It holds the draft against the saved setup and its expected revision, and saves with `save(setup?, writes?)`. On a conflict it keeps the draft and loads the current saved setup beside it. It registers the window's SaveGuard; `extra` adds further unsaved work, such as the Race's open stat sheet, that the guard saves or discards with the draft.

The command accepts a Box that is present in the Chat, enabled or disabled, and checks the value against the schema. An absent Box takes no setup, so nothing saved before an insert survives into it. A setup that must land with the Box's own data writes goes in one [`commit-box`](host.md#storage) instead.

`setupError(setup, previous)` rejects a setup the schema accepts but the Box does not. Its message fails the command and shows in the window.

`importSillyTavernNote(note)` returns the setup, a value of the setup schema, that a SillyTavern chat's Author's Note imports as. The host writes it to the new Chat. Only the Author Note declares it.

### `moves` and `moves.render`

Actions the writer attaches to a Human-authored Message, declared as `describeMoves(schema, max, label)` from the shared SDK. `max` bounds the Moves per Message, and `label(move)` is the chip text. The host shows the Box's icon before it, so the label carries no icon or emoji of its own. `seatBound: true` ties staged Moves to the human seat ([Move staging](host.md#move-staging)). The server Box must declare `render(move, author)`.

The host stores each Box's Moves in order in `messages_data` under key `moves`. For the Generation prompt, Lore scanning and Generation-time Memory recall, the Message's text becomes each Move's `render`, one per line, then the prose. Digests, Memory's extraction among them, read the raw prose. While the Box is not enabled, the host uses the Move's chip label instead of `render`, so a removed Box never breaks past Messages. [Move staging](host.md#move-staging) covers the composer.

Validate staged Moves with the same function the Box resolves them with, kept in `shared.ts`. A Move that was legal when staged may fizzle at resolution, and the Box narrates the failure.

### `record` and `records`

`record` is the `Type.Object` schema of one Variant's record. An object, so an absent record is never confused with a record's value. The server Box must declare `records`. `records.initial` and `records.fold` come together: with them, state is the fold of the Box's records; without them, as in Memory, state is `undefined` and the Box reads its records from the slots `CaptureRead` carries. State is never stored: the host folds it whenever it needs it, for Generation capture, the window `read` and `status`.

Records come from two places: `advance` returns one at Generation time (the Race), or `records.digest` reads settled prose later (World Clock, Mood). Any Box with a `record` accepts Writer overrides through `set-box-record` and `reset-box-record`. Only digesting Boxes get an editor for them, in the [passage timeline](host.md#passage-timeline). An override is refused while its Variant is still generating. Digests change records without a Conversation revision, so `set-box-record` names the effective record the writer's draft started from as `expected`, `null` for none, and the host refuses the override when the slot no longer holds it. The timeline's editor captures it as it opens; a refused save keeps the draft and shows the record there now, so saving again overrides that one. Memory's claim corrections send the claims they edited.

Pick the record's granularity by what an upstream change should do to it:

- **Facts about the passage**, when an earlier change should shift the result. The World Clock stores elapsed minutes and weather, so editing an earlier passage's duration moves every later time.
- **The whole resulting state**, when a step is only meaningful from the exact state it ran on. The Race stores the standings and Hidden intents after each turn, and its fold takes them from the last record, so an earlier change never replays later Stretches. A record never copies an earlier one: the Race's adds at most one replay entry, which the fold appends.

### `decision`, `records.digest` and `status`

`decision` makes the Box a digesting Box (a [delegating Box](#delegate-and-delegateapply) is the other kind the queue runs, and a Box is never both): the server Box must declare `records.digest`, and may declare `status` but not `read`. That one key gives the Box the [digest queue and catch-up](host.md#digest-queue-and-catch-up), the [passage timeline](host.md#passage-timeline) as its window read, and a global Decision Model selection in Connection Settings, worded by the four `decision` strings. The host stores the selection (profile, model and state token limit) in `library_data` under its own `box-decision` namespace, keyed by the Box id. Without a selection no digest runs.

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
- **The job.** Once a passage holding the tag settles, the [digest queue](host.md#digest-queue-and-catch-up) runs a delegate job for it under its landing rules. Jobs of one Chat and Box run one at a time in passage order: one waits while another of that Chat and Box runs, a dropped one included until it settles, or while an earlier passage's is queued. The job folds `state` from the selected records strictly before its passage, never its own earlier record or a later one, so a retry cannot apply its request twice, and retrying an earlier passage never re-runs a later one.
- **The agent.** One libfx agent per job (`createFxAgent`, Wasm, `memory()`), on the Box's delegate setting resolved by `resolveLibfxProvider`, the resolution Creator Mode's coding agent uses. Its prompt holds the passage, the request and the state as JSON; past 64 KiB the run fails rather than cut state short. Its one tool, `apply`, takes `{ operations }` checked against `delegateApplyInput(operations)`: an invalid batch goes back to the model as a tool error, the first valid call is the batch, and a second call fails the run. Model requests and tool calls, a call to a tool it does not have included, count against one 10-step cap. The job's abort cancels the turn and its fetches, and the agent is closed when the job ends. A turn that ends without `apply` or without `end_turn` fails. Nothing is written until the turn ends and `delegate.apply` returns; its throw fails the run with its message, and so does a reducer still pending after 10 seconds (`DELEGATE_APPLY_MS`), whose job holds its lane until then. The agent sees the prompt and the schema and nothing else.
- **The setting.** Profile and model, edited in Connection Settings beside the Decision Model settings, stored in `library_data` under the host's `box-delegate` namespace and served at `/api/boxes/<id>/delegate-settings`. The host default uses the reserved `$default` key and the same route and apply/conflict flow; it appears once above the per-Box rows. A Box with its own profile uses it; without one it uses the default. With neither, the delegate is off and nothing queues. Choosing a model never runs missed requests automatically. A setting that does not resolve still queues, and each run fails with its reason.
- **The window.** `DelegateNotice`'s read follows the database's changes, and counts as `landed` the passages whose record is the delegate's run on their current text; a delegating Box's `useBoxRead` keys on that count beside the Conversation revision, so a landed record shows without a revision while the window read does not refetch on every change, since a guest commits at the snapshot it read. `DelegateNotice` at the top of the window reads `GET /api/conversations/:id/boxes/<id>/delegate` and says "The delegate failed on Message N: <reason>", N the passage's place on the Selected path, with **Retry**, which posts the passage to the queue's `/digest` route; without a failure, a broken setting says why. An enabled Box whose delegate is off shows a neutral notice naming the Box, with an action opening its delegate model editor in Connection Settings. The read also counts tagged passages without a current record or failure; when ready, the notice offers **Run missed requests** to start the existing catch-up, then shows its progress instead of the button. Writer overrides work as for any Box with a record.

Once a version declares `delegate`, Install refuses a later one that drops it or renames its tag ([Versions](sandboxed.md#versions)). `run_scenario` scripts each step's batch as `delegated` ([Creator Mode](creator-mode.md#creator-mode)).

### `advance`

The Box's turn in a Generation: Send, Continuation, Sibling and Prompt Plan preview alike. `run(input, ctx)` gets `input = { setup, dependencies, state, moves }`. `moves` are the ones on the triggering Human-authored Message: the one sent, or the one a Sibling answers. A Continuation has none, and neither does a Sibling of a Message that follows the model's own.

It returns `{ items, allowance?, trace?, record? }`:

- `items` are `{ text, priority, pinned?, literal? }`, with `priority` a finite number. [Admission](host.md#generation-lifecycle) places them in the Box's block after its instructions. A `literal` item skips the Prompt Macro pass; Memory marks recalled claims literal so a stored claim never runs a macro. An empty list leaves the whole block out, instructions included, unless the descriptor declares `alwaysRender`. A Box without `advance` returns an empty list. For sandboxed Boxes, see [Images in prompt items](../../src/server/authoring/contract.md#images-in-prompt-items) for sending window uploads through item text, including literal items.
- `allowance`, a whole number of tokens, caps the unpinned items'.
- `record` passes the descriptor's `record` and is written to the new Variant as the slot's `automatic` value when the Variant resolves. The record is stamped with the Box's instance at capture. Only a Box with a `record` descriptor returns one.
- `trace` is JSON that passes `advance.trace`; a Box without `advance.trace` returns none, so a Fork can rewrite every stored trace. The host keeps it, unread, in the Generation's Box traces, keyed by `box:<id>`, beside its budget evidence: the allowance, each item's admission (`admitted`, `allowance`, `oversized` or `context-limit`) in the Box's order, and the block's text as budgeted and as sent, which differ once the writer edits the inspected Prompt Plan. The allowance governs only automatic admission: an edited block answers to the plan's context limit alone, since the Writer's explicit choice wins, as with record overrides. Memory's trace view reads Memory's entry.

`fingerprint(input)` replaces `dependencies` in the [preview fingerprint](host.md#generation-lifecycle). Declare it only when the dependencies do not serialize to what should mark a preview stale. Only Memory declares it.

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

`strip` is also the parser the window `read` uses to list what was lifted, so it is one function in `shared.ts`. Malformed markup stays raw text. Unit-test it on malformed and nested input. [The lens pipeline](host.md#lens-pipeline) describes how lenses combine.

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

The layer rules read Box file names too: a `client*` file imports `server*` code only for types, a `shared*` or `contract*` file imports neither, and a `Type.Object` in a `server*` or `client*` file fails `bun run lint`. The SDK entries re-export only what the built-in Boxes use; read them for the list. The server entry exports no table: a Box reaches its stored data through the reads and writes in [Storage](host.md#storage), and a host fact it checks through a read of its own, such as `readProfileApiFormat` for a Connection Profile's API format, so a change to the host's schema changes no Box. When a Box needs something else from the host, add it to its layer's entry.
