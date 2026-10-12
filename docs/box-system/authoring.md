# Writing a Box

A Box is a compiled-in story feature. It owns what its state means. The host stores that state, orders it along the story and routes it to the right place, and never interprets it. See [ADR-0050](../adr/0050-build-story-features-as-boxes.md) for why Boxes exist and [the spec](spec.md) for the product decisions.

A Box is its own files plus one entry in each of three registries:

| Registry | File | Entry |
|---|---|---|
| Descriptor | `src/shared/contract/box.ts` | the id in `boxIds` and its `boxDescriptors` entry |
| Server | `src/server/box/registry.ts` | `<id>: <id>Box` in the `serverBox` lookup |
| Client | `src/client/box-windows/registry.tsx` | the `boxWindows` entry, only if the Box has a window |

Everything else the host derives from those entries: the preset block, the Box manager, capture, setup decoding, record folding, Moves, digests, catch-up, Writer overrides, the Decision Model setting, the window read route, the launcher, the dock and the lens. You never edit host code to add a Box. If you find you need to, the host is missing a generalization. Stop and raise it rather than adding a special case.

## Add a Box

Each step ends with a check that runs without a live app. Run heavy commands through `flock /tmp/ditzy-heavy.lock`.

1. **Choose the hooks.** Read [Hooks](#hooks) and pick only what the Box needs. The descriptor keys you set decide which server hooks the type checker demands, so decide first.

   | The Box… | Descriptor | Server module | Client entry |
   |---|---|---|---|
   | adds text to the prompt | — | `advance` | — |
   | has per-Chat configuration | `setup` | `setupError` if the schema cannot express a rule | a `Panel` that sends `set-box-setup` |
   | lets the writer attach actions to a Message | `moves` | `moves.render` | a `Panel` that stages Moves |
   | settles facts per Variant at Generation time | `record` | `records`, and `advance` returns `record` | — |
   | reads finished prose in the background | `record` and `decision` | `records` with `digest`; `status` optional | `digestWindow("<id>", { icon, size })`; `Panel` and `describe` optional |
   | shows a window | — | `read`, if the Panel needs data the Chat summary lacks | `icon`, `size`, `Panel`, `DockTab` |
   | lifts markup out of the story view | — | — | `lens` (needs the window entry) |
   | needs Cast names, the seed or the intent | — | `dependencies` | — |
   | keeps Chat data outside the Box tables | — | `remove` | — |

   Done when you can name each descriptor key and hook the Box declares.

2. **Write the shared module.** Put every schema and every function both server and client use under `src/shared/`. Larger Boxes split schemas into `src/shared/contract/<id>.ts` and logic into `src/shared/<id>.ts` (the Race, World Clock and Phone). A small Box keeps both in `src/shared/<id>.ts` (Thoughts). A `Type.Object` schema declared under `src/client/` or `src/server/` fails `check:contracts`, and a parser the lens and the window `read` both use must be the same function, so neither belongs in a server or client module. Done when `bun run check:contracts` passes.

3. **Register the Box and write its server module.** Add the id to `boxIds` and its entry to `boxDescriptors` in `src/shared/contract/box.ts` (see [Descriptor](#descriptor)). Create `src/server/box/<id>.ts` exporting `<id>Box`, an object that `satisfies Box<…>` from `src/server/box/contract.ts`, and add it to the `serverBox` lookup in `src/server/box/registry.ts`. Do all three before the check. The `serverBox` lookup is typed over every id in `boxIds`, so the build fails until the server entry exists, and it fails if the descriptor declares a key whose hook the server module lacks: `record` needs `records`, `decision` needs `records.digest`, `moves` needs `moves.render`. Each entry is also checked against its own id's descriptor, so a Box whose setup, record or Move types differ from that descriptor's schemas fails to register. Done when `bun run typecheck` passes.

4. **Write the window**, if the Box has one. Create `src/client/box-windows/<Name>Window.tsx` and add the `boxWindows` entry (see [Window](#window)). A digesting Box always needs the entry, because the entry is what gives it a window and a dock tab. It needs no window file when it has no setup and the generic record summary reads well: the entry is then just `digestWindow("<id>", { icon, size })`. Done when `bun run typecheck` passes.

5. **Test it.** Write one e2e spec, `e2e/<id>.spec.ts`, per user flow, and assert through Prompt Plan inspection. Every test runs on a fresh database, so the Default preset already has the Box's block (see [Preset block](#preset-block)). Insert the Box with `insertBox(page, "<label>")` from `e2e/fixtures.ts`. A digesting Box needs `selectBoxDecisionModel(request, "<id>")` and scripted decisions through `llm.decisions(…)`; `e2e/world-clock.spec.ts` shows both. The human's Messages are digested too, and the first matching rule wins, so end the scripted decisions with a catch-all rule after the passage-specific ones. Add unit tests only for logic that can really fail, such as a parser on malformed markup, determinism for a given seed, or a fold. Done when `bun run check` and `bun run test:e2e` pass.

That is the whole list. The rest of this guide explains what each piece means.

## Descriptor

`boxDescriptors` in `src/shared/contract/box.ts` holds what the host shows, defaults and stores for each Box. Both server and client read it.

| Key | Meaning | What the host derives |
|---|---|---|
| `label` | Display name | the preset block label, the add-block menu, the Box manager, window titles, dock tab names, the Decision Model setting's name |
| `role` | `system`, `user` or `assistant` | the outgoing role of the Box's preset block until an author changes it |
| `startsEnabled` | whether a new Chat starts with the Box enabled | `defaultBoxIds` |
| `setup` | `setupOf(schema, initial)` | `boxSetups` on the Chat summary, decoding in `readBoxSetups`, the accepted `set-box-setup` actions |
| `record` | a `Type.Object` schema for one Variant's record | `boxRecords`, record slots, the `set-box-record` and `reset-box-record` actions, the passage timeline's override editor |
| `moves` | `movesOf(schema, max, label)`, plus `seatBound: true` if a seat change should drop staged Moves | `boxMoves`, chip labels, composer staging, Move rendering |
| `decision` | `{ summary, description, off, context }` | `digestBoxIds`: the digest queue, catch-up, the timeline, the dock tab and a Decision Model selection in Connection Settings, using these four strings as its copy |

A Box id is also its preset reference and data namespace, both `box:<id>`.

## Hooks

The server contract lives in `src/server/box/contract.ts`:

```ts
interface Box<Setup, Dependencies = undefined, Trace = never, Services extends keyof BoxServices = never, Rec = never, State = undefined, Move = never> {
  inject?: readonly Services[];
  setupError?(setup: Setup, previous: Setup): string | undefined;
  moves?: { render(move: Move, author: string): string };
  dependencies?(read: CaptureRead, setup: Setup): Dependencies;
  records?: {
    initial: State;
    fold(state: State, record: Rec, setup: Setup): State;
    digest?: { window: number; run(window: DigestWindow, ctx: DigestContext): Promise<Rec> };
  };
  advance?: {
    trace?: TSchema;
    run(input: AdvanceInput<Setup, Dependencies, State, Move>, ctx: BoxContext<Services>): Promise<AdvanceResult<Trace, Rec>>;
    fingerprint?(input: AdvanceInput<Setup, Dependencies, State, Move>): string;
    withoutBlock?(input: AdvanceInput<Setup, Dependencies, State, Move>): AdvanceResult<Trace, Rec>;
  };
  status?(setup: Setup, state: State): string | null;
  read?(database: Database, conversationId: number): GenerationJsonValue | undefined;
  remove?(db: BunSQLiteDatabase, conversationId: number): void;
}

type AdvanceInput<Setup, Dependencies, State, Move> = { setup: Setup; dependencies: Dependencies; state: State; moves: readonly Move[] };
type AdvanceResult<Trace, Rec> = { items: readonly BlockItem[]; allowance?: number; trace?: Trace; record?: Rec };
type BlockItem = { text: string; priority: number; pinned?: boolean; literal?: boolean };
```

Every hook is optional. Pick the type parameters to match: `Setup` is the setup schema's type (`undefined` without one), `Rec` the record schema's, `Move` the Move schema's. The Thoughts Box is `satisfies Box<undefined>`.

Every hook below ends with a "Host wiring" line. For every hook it says the same thing, because the host finds each one through the registries. A Box never adds a route, a table, a command or a stylesheet.

### `advance`

The Box's turn in a Generation. During preparation the host captures every Box that is enabled in the Chat and has an enabled preset block, then calls `advance.run` for all of them in parallel. That covers Send, Continuation, Sibling and Prompt Plan preview. Boxes never see each other's results.

`AdvanceInput` holds the Box's setup, its folded state (see [`records`](#records)), the Moves on the triggering Human-authored Message, and its `dependencies`. The Moves come from the Message being sent, or the one a Sibling answers. A Continuation gets none.

What the host does with the result:

- `items` go into the Box's preset block and through the Prompt Macro pass, except a `literal` item, whose text goes in as written. Memory marks its recalled claims literal, so a stored claim never runs a macro. The host admits pinned items first. It then admits unpinned items whole, by descending `priority`, while they fit `allowance`, or the remaining context when there is no allowance. Pinned items ignore the allowance but count toward the context limit, and a plan that overflows it raises `PromptBudgetExceededError`. An empty `items` list leaves the block out.
- `record` is checked against the descriptor's `record` schema, held on the Active Generation with the Box instance captured for it, and written to the new Variant as the slot's `automatic` value when it resolves. Returning a record without a `record` descriptor throws.
- `trace` is checked against `advance.trace` when the Box declares that schema. Only Memory's trace has a consumer: it becomes the Generation's Memory activation record. A new Box's trace goes nowhere.

`fingerprint` replaces `dependencies` in the preview fingerprint. The host fingerprints the whole preparation snapshot, seed included, plus each Box's setup, state, Moves and `dependencies`. Declare `fingerprint` only when the dependencies do not serialize to what should make a preview stale. If the fingerprint changes between preview and send, the send fails with "The Prompt Plan is stale". Only Memory declares it, returning its freshness fingerprint.

`withoutBlock` captures the Box even when its preset block is disabled, and returns its result instead of calling `run`. Only Memory declares it, to record activation evidence with no items.

Pilot consumers. All six Boxes declare `run`. The Author Note returns its note as one pinned item, or none when blank. The Thoughts Box returns one pinned instruction. Memory returns prioritized claims under its `allowance` plus a `trace`. The Race returns one pinned Stretch and a `record`. The World Clock returns its clock line as one pinned item.

Host wiring: none.

### `dependencies`

What the Box needs beyond setup, state and Moves. The host calls `dependencies(read, setup)` at capture and passes the result to `advance` as `input.dependencies`. `read` is the `CaptureRead` the host built for this Generation:

| Field | Value |
|---|---|
| `seed` | this Box's own stream of the Variant's seed, already derived with `boxSeed(seed, id)` |
| `intent` | `"continue"` for a Continuation, and for a Sibling whose preceding Message the model wrote; otherwise `"respond"` |
| `human` | the human-controlled Participant's `{ id, name }` |
| `cast` | every Cast member's `{ id, name }` |
| `memory()` | Memory's recall snapshot; only Memory calls it |

Without the hook, `input.dependencies` is `undefined`.

Pilot consumers. The Race takes `{ seed, intent, withdrawn }`, where `withdrawn` lists slotted Runners whose Participant left the Cast. The Phone takes the human and contact names. Memory takes `read.memory()`.

Host wiring: none.

### `inject`

Lists the provider services `advance.run` receives on `ctx`: `llm`, `decide` and `embed`. `ctx` always has `signal`, which aborts when the server shuts down. The host builds `ctx` from exactly the declared keys, so a Box that does not declare `embed` cannot call it.

Pilot consumer. Memory declares `["decide", "embed"]` for its relevance pass and embedding query.

Host wiring: none.

### `setup`

The Box's per-Chat configuration. Declare it with `setupOf(schema, initial)` in the descriptor. The host stores it in `conversation_data` under `box:<id>`, key `setup`. A Chat with no stored setup reads `initial`. A stored value that fails the schema is an error that tells the writer to clear the namespace. There is no migration path, by design.

The Chat summary carries every setup as `conversation.boxSetups[<id>]`. A Panel saves a new one with the `set-box-setup` command, `{ type: "set-box-setup", box: "<id>", setup, writes? }`. Edit it through `useBoxSetupDraft("<id>", { conversation, disabled, onConversationChange, conflict, valid?, onSaved? })` in `src/client/box-windows/useBoxSetupDraft.ts`, as the Author Note, World Clock and Race do. It holds the draft against the saved setup and its expected revision, sends the command with `save(setup?, writes?)`, keeps the draft on a conflict and loads the current saved setup beside it, and registers the window's SaveGuard; `extra` adds further unsaved work, such as the Race's open stat sheet, that the guard saves or discards with it. The command accepts any Box with a `setup` descriptor that is present in the Chat, enabled or disabled, and checks the value against its schema. An absent Box takes no setup, so nothing saved before an insert survives into it.

`writes` are the Box's own data writes, each `{ owner, key, value }` as in [`put-box-data`](#storage), that must land with the setup or not at all. They run through the `put-box-data` checks, owner revisions included, in the setup's transaction, so one refused write commits neither the setup nor any other write. The Race's "Add to field" saves the new gate with the Participant's stats, and the Character's when asked for, this way.

`setupError(setup, previous)` rejects a setup the schema accepts but the Box does not. Return a message and the command fails with it, and the window shows it. The World Clock rejects impossible dates such as February 31. The Race rejects course or field changes once a race is running.

Pilot consumers. Author Note (the note text), World Clock (start, era, climate, hemisphere, unit), Race (course, field, Auto mode, phase).

Host wiring: none.

### `moves`

Actions the writer attaches to a Human-authored Message. Declare the schema, the per-Message maximum and the chip label in the descriptor with `movesOf(schema, max, label)`, and `render` on the server Box.

A Panel stages Moves through its `staging` prop: read `staging.moves[<id>]` and call `staging.onChange({ ...staging.moves, <id>: [...staged, move] })`. They show as chips the writer can drag to reorder or remove. A Message may hold only Moves. The host stores each Box's list in order in `messages_data` under `box:<id>`, key `moves`.

The host calls `render(move, author)` for the Generation prompt, Lore scanning and Generation-time Memory recall. Background Memory extraction and digests read raw prose without Moves. The Message's text becomes each Move rendered, one per line, then the prose. While the Box is not enabled in the Chat, the host uses the Move's chip label instead, so removing a Box never breaks past Messages.

Newly submitted Moves for a Box that is not enabled are rejected, and the composer drops staged Moves for a Box that stops being enabled. With `seatBound: true` it also drops them when the human seat changes. A Send that retries an existing Human-authored Message keeps the Moves already stored on it. `set-message-moves` replaces a past Message's Moves, and regenerating its reply replays the turn.

Validate staged Moves with the same function the Box uses at resolution, kept in `src/shared/`. The Race's `checkRaceMove(setup, state, earlier, move)` in `src/shared/race-moves.ts` returns `{ legal, cost, odds }` or `{ legal: false, reason }`. The window offers only legal Moves, and `advance` fizzles a Move that turned illegal.

Pilot consumers. Race (Overtake, Conserve, Spurt, Hold, rendered as `(Race Move: … )`) and Phone (outgoing texts, rendered as `<sms>` from the author, seat-bound).

Host wiring: none.

### `records`

Facts the story has settled, one per Variant. State is never stored. The host folds it each time it needs it: `fold(state, record, setup)` over the effective record of each selected Variant, in Message order, starting from `initial`. The effective record is the Writer override if there is one, else the automatic result. See [History](#history) for what that means for your design.

Declare the record schema as the descriptor's `record`, a `Type.Object`, so an absent record is never confused with a record's value. The host stores one slot per Variant in `message_variant_data` under `box:<id>`, key `record:<instance>`, shaped `{ automatic?, writer?, source? }`. `source` hashes the digested text, so an edit is digested again.

Records come from two places. `advance` returns one at Generation time, as the Race does. `records.digest` reads finished prose later, as the World Clock does.

Any Box with a `record` descriptor accepts Writer overrides through `set-box-record` and `reset-box-record`. Only digesting Boxes get an editor for them, in the [passage timeline](#passage-timeline).

Pilot consumers. World Clock (`{ minutes, weather }` per passage) and Race (`{ raceId, stretch, outcome, after }` per Stretch).

Host wiring: none.

### `records.digest`

Background reading of prose the story has settled. Declare `decision` in the descriptor alongside `record`, and `records.digest` on the server Box. That one declaration gives the Box:

- the host digest queue and catch-up,
- a global Decision Model selection, stored in `library_data` under the host's `box-decision` namespace, keyed by the Box id, and shown in Connection Settings with the descriptor's `decision` copy,
- its window read, the [passage timeline](#passage-timeline) with Writer overrides, and a dock tab showing `status`.

The host queues a digest for a selected Variant when it resolves, when it becomes selected without a record for its current text, or when its text is edited. It skips Variants that are empty or still generating. Two workers drain the queue, live jobs before catch-up jobs. A newer job for the same Variant aborts the older one. Jobs live in memory, so a restart loses them; the passage is queued again when it is next selected, resolved or edited, or by catch-up. Generations never wait for digests. Without a Decision Model selection no digest runs.

`run(window, ctx)` gets `{ passage, preceding, seed }`. `passage` and each preceding entry are `{ speaker, content }`. `seed` is this Box's stream of the Variant's seed. `preceding` holds up to `window` selected Messages before the passage, oldest first: 0 gives none, and a larger `window` gets as many as the path has. `ctx.decide(state, questions)` asks the Box's own Decision Model selection; the host packs the request and throws if `state` exceeds the selection's token limit. `ctx.signal` aborts when the job is superseded or cancelled.

A question is keyed by name and the answers come back as a `Map` with the same keys. A `choice` question names its options as `criteria` keys, each mapped to what that option means, and its answer is `{ type: "choice", choice }`:

```ts
const answers = await ctx.decide({ passage, preceding }, {
  mood: { type: "choice", instructions: { question: "What mood does `passage` leave the scene in?" }, criteria: { calm: "…", tense: "…" } },
});
const answer = answers.get("mood"); // { type: "choice", choice: "tense", … }
```

Treat an answer outside your options as an error and throw. Digests also run on the human's own Messages, not just the model's.

The host checks the result against the record schema and writes it as the slot's `automatic` value with a hash of the digested text. It discards the result if the text changed, a newer job replaced it, the Box stopped being enabled, the catch-up run was cancelled, or the selection went away. A thrown error is logged and leaves no record.

`status(setup, state)` is the dock tab's line. Its accessible name is `<label>: <status>`, which is how an e2e test finds it. The host calls it only in the passage timeline read, with the state folded over every selected record, the same state Generation capture folds, so only digesting Boxes may declare it. Without it the dock tab shows the Box's label.

Pilot consumer. The World Clock asks two `choice` questions, elapsed time and weather, and draws exact minutes inside the chosen bin from `seed`. Its status is `8:41 AM · ☀️ 3°C`.

Host wiring: none.

### `read`

The window's data for a Box that does not digest. The host serves it at `GET /api/conversations/:id/boxes/<id>`. Return `undefined` for a missing Chat and the route answers 404. The value must be JSON. Declare its schema in `src/shared/` and decode it on the client:

```ts
foundOrNull(await requestOutcome(api.api.conversations({ id }).boxes({ box: "<id>" }).get({ fetch: { signal } }), <id>Read, notFoundOutcome))
```

Read inside `runConversationReadTransaction`, and use `readSelectedHistoryFromConnection` for the Selected path. Send only what a spectator may see: the Race read returns its replay and Hidden intents only after the finish. Key the client query by `conversation.revision`, as the Thoughts and Phone windows do, so it refetches when the Chat changes.

A digesting Box declares no `read`. The host serves the passage timeline at that route instead, and the type checker rejects a `read` on such a Box.

Pilot consumers. Race, Phone and Thoughts.

Host wiring: none.

### `remove`

Deletes Chat-scoped data the Box keeps outside `conversation_data` and `participant_data` when the writer removes the Box from a Chat. The host calls it inside the removal transaction, after deleting the Box's `conversation_data` and this Chat's `participant_data` in its namespace. A Box that keeps everything in its data scopes needs no `remove`.

Pilot consumer. Memory deletes its per-Chat settings row.

Host wiring: none.

## Window

The client half of a Box lives in `boxWindows` in `src/client/box-windows/registry.tsx`, because React components do not belong on the server contract. An entry has:

| Key | Meaning |
|---|---|
| `icon` | a `lucide-react` icon, used by the launcher button, the window bar and the generic dock tab |
| `size` | `{ width, height }` in rem |
| `Panel` | the window body |
| `DockTab` | the minimized window's tab |
| `lens` | optional, see [Lens](#lens) |

A digesting Box builds its entry with `digestWindow("<id>", { icon, size, Panel?, describe? })` from `PassageTimeline.tsx`. It returns an ordinary entry whose `Panel` is the Box's own `Panel`, if any, followed by the [passage timeline](#passage-timeline), and whose `DockTab` shows `status`. Any other Box declares both itself.

The composer shows a launcher button for each enabled Box with an entry. Windows drag but do not resize, several can be open at once, and minimizing turns a window into its dock tab. Open state, minimization and position are stored per Chat in local storage. On narrow layouts a window becomes a full-screen layer with focus trapped inside.

`Panel` props:

| Prop | Use |
|---|---|
| `conversation` | the `ConversationSummary`, with `boxSetups`, `boxes`, `cast`, `control` and `revision` |
| `disabled` | true while a Prompt Plan preview is open or a Generation is assembling; disable every control that sends a command |
| `staging` | the composer's staged Moves (see [`moves`](#moves)) |
| `boxData` | `boxData(owner, key, value)` builds a `put-box-data` command for this Box's own namespace |
| `onConversationChange` | pass it to `runConversationCommand` so the Chat summary updates |

`DockTab` gets `conversation` and `onRestore`. Render a `<button type="button" className="box-dock-tab">` with the icon, an `sr-only` label and one short line, as `ThoughtDockTab` does.

### Window CSS

The host styles the window frame, the dock and the passage timeline in `src/styles/box-windows.css`. A Box adds no stylesheet. Style the Panel with Tailwind utilities on the elements and the shadcn components in `src/components/ui/` (`Button`, `Field`, `Input`, `Select`, `SegmentedControl`, `Alert`). `ThoughtWindow.tsx` is the model: `text-muted-foreground`, `bg-muted`, `rounded-xl` and `font-(family-name:--font-reading)` for story text. The World Clock and Race windows still use classes in `box-windows.css` from before the host was generic; do not copy that. Follow `DESIGN.md` for visual decisions.

## Lens

A lens lifts the Box's markup out of the story view and leaves a mark that opens the window. The prompt keeps the raw markup. A lens belongs to a `boxWindows` entry, so a Box with a lens has a window.

Build it with the `lens` helper in `registry.tsx`:

```ts
lens(tag, gate, strip, View)
```

| Argument | Contract |
|---|---|
| `tag` | the markup tag, such as `"thought"` for `<thought>…</thought>` |
| `gate(conversation)` | returns a context value, or `undefined` when nothing should be lifted in this Chat |
| `strip(text, context)` | splits prose into `{ kind: "prose", text: string }` and `{ kind: tag, text: Text }` segments, in order |
| `View` | a component taking `{ text: Text, onOpen }` that renders one lifted segment; `onOpen` opens the Box's window |

The story view applies lenses only for enabled Boxes, in `boxIds` order, each to the prose the earlier ones left. A lifted piece is never lensed again. While a Message streams, an unclosed `<tag` is hidden instead of flashing as raw markup.

`strip` is the parser the window `read` also uses to list what was lifted, so it lives in `src/shared/`, as `stripThoughts` in `src/shared/thought.ts` and `stripPhoneTexts` in `src/shared/phone.ts` do. Malformed markup stays raw text. Write unit tests for the parser on malformed and nested input.

Pilot consumers. Thoughts lifts every `<thought>` (`gate` returns `true`). Phone lifts `<sms from="…" to="…">` only when both names are the human-controlled Participant and a Cast member, so its `gate` returns the Cast names and `undefined` without a human seat.

## Passage timeline

Every digesting Box's window ends with the host's passage timeline, `src/client/box-windows/PassageTimeline.tsx`, after the Box's `Panel` if it has one. It lists the selected path's passages with each one's record, an "Overridden" mark, Edit and Reset, and a "Digest missing passages" action that shows catch-up progress and can be cancelled. It tells the writer to pick a Decision Model in Connection Settings when there is none.

The override editor is built from the descriptor's `record` schema:

| Field schema | Editor |
|---|---|
| a union of `Type.Literal`s, optionally with `Type.Null()` | a select with one option per member |
| `Type.Integer()` or `Type.Number()` | a number input, bounded by `minimum` and `maximum` |
| `Type.String()` | a text input |

Any other field type, and any `Type.Optional` field, throws when `digestWindow` registers the window, so the client fails at load rather than when the window opens. A field that may be unset must be a union of literals with `Type.Null()`; a nullable number or string is not supported. Write each option out as its own `Type.Literal`. A union built with a spread, such as `Type.Union(names.map(Type.Literal))`, typechecks on the server but fails the client's typecheck. Each schema's `title` labels its field or option: `Type.Union([…], { title: "Weather" })`, `Type.Literal("rain", { title: "🌧️ Rain" })`, `Type.Null({ title: "Not mentioned" })`. Without a title the key or value is shown. A new passage's draft starts a nullable choice at `null` and leaves every other field empty. Save stays disabled until the draft passes the record schema.

The timeline summarizes a record by joining its fields with ` · `: a choice shows its option's title, a number or string shows its value, and a `null` field is left out. When that reads badly, pass `describe(record)` to `digestWindow`; it takes the Box's own record type. The World Clock's turns `{ minutes: 5, weather: "clear" }` into `+5m · ☀️ Clear`.

A Panel that changes something the status depends on, such as setup, refreshes the timeline and dock with `client.invalidateQueries({ queryKey: boxDigestKey(conversation.id, "<id>") })`.

## Storage

| Scope | Table | Written by |
|---|---|---|
| Library | `library_data (namespace, key, value)` | Box window, through `put-box-data`; the host, for the Decision Model selection |
| Character | `character_data (character_id, namespace, key, value)` | Box window, through `put-box-data` |
| Participant | `participant_data (participant_id, namespace, key, value)` | Copied from Character data when a Character seeds a Participant, then Box window through `put-box-data` |
| Conversation | `conversation_data` | Host, as `enabled`, `instance` and `setup` |
| Message | `messages_data` | Host, as `moves` |
| Variant | `message_variant_data` | Host, as `record:<instance>` from `advance`, digests and Writer overrides |

The namespace is always `box:<id>`. The host keeps no Library value of its own there: the Decision Model selection lives in the host's `box-decision` namespace. A Panel writes Library, Character and Participant data with its `boxData` prop, which fixes the Box id, so no window can name another Box's namespace. The host rejects `put-box-data` for a Box that is not enabled in the Chat, and for an owner that does not exist. Values are strings. The Box decodes its own and treats a value that fails its schema as an error, never as a row to skip. Character data and Participant data are independent after the copy, so a later Character edit never reaches an existing Participant.

Each Variant also holds one Generation seed, shared by every Box, under namespace `box`, key `seed`. `boxSeed(seed, id)` gives each Box its own stream. A Variant with no seed, such as an imported one, uses `variant:<id>`.

Boxes cannot add tables. A feature that needs relational queries stays in-tree code that owns its tables, like Lorebooks and, until its full port, Memory.

## Preset block

Each Box has one preset block with reference `box:<id>`, labelled and given its default role from the descriptor. The preset editor's add-block menu lists every Box. The database needs no migration, because its constraints accept any `box:` reference.

`installDefaultPresetBoxes` in `src/server/prompt-preset/recipe.ts` runs only when the server creates a fresh database. It inserts every missing Box block into the Default preset, directly after history. An existing database never gets the new block on its own: add it to the Default preset with the add-block action, or start from a fresh database. e2e tests always run on a fresh database, so they see the block.

The preset decides where a Box goes; the Chat decides whether it runs. A Box with nothing to say, or that is not enabled, contributes no block.

## History

The rule comes from Macro State. Records are resolved values. Selecting an earlier Variant, editing it, or overriding it never recomputes, invalidates or drops a later record. The fold just runs over whatever is selected now.

- **Swipe.** A Sibling reuses the Moves of the Message it answers and the seed of the Variant it replaces. Same state, Moves and seed give the same outcome, so a swipe rewrites only the prose.
- **Re-roll.** A Sibling with a fresh seed. The Moves are the same and the outcome is new.
- **Variant selection.** State follows the selected Variants, so alternatives never leak into each other.
- **Writer override.** The writer's record replaces the effective value without touching prose or the automatic result. A later digest never displaces it, and reset removes it.
- **Late digests.** A finished Variant keeps the inputs it was generated with. A digest that lands later changes only what the next Generation folds.

Pick the record's granularity by what an upstream change should do to it.

- Record **facts about the passage** when an earlier change should shift the result. The World Clock stores elapsed minutes and weather, so editing an earlier passage's duration moves every later absolute time.
- Record **the whole resulting state** when a step is only meaningful from the exact state it ran on. The Race stores the post-Stretch state in `after`, and its fold just returns it. An earlier change never replays later Stretches.

## Lifecycle per Chat

Each Box is enabled, disabled or absent in each Chat. The host stores `enabled: true | false` and an `instance` id in `conversation_data` under `box:<id>`. No row means absent. Server code checks with `isBoxEnabled` or `readBoxStates` from `src/server/box/setup.ts`; client code reads `conversation.boxes[<id>]`.

- **Enabled.** The only state where the Box runs. It is captured into the Prompt Plan when its preset block is also enabled, queues digests, accepts Moves and `put-box-data`, and shows its launcher, window, dock tab and lens.
- **Disabled.** Nothing runs and nothing reaches the prompt. Setup and data stay. Re-enabling picks up where the Box left off.
- **Absent.** Removing deletes the Box's `conversation_data`, its instance included, this Chat's `participant_data` in its namespace, and whatever its `remove` hook deletes. Library and Character data, Variant records and Message Moves stay, because history is immutable.

Each insert gives the Box a new instance id; disabling keeps it. The host stamps every record slot with the instance that wrote it and folds only the current instance's slots. A reinserted Box therefore starts from `setup.initial` and `records.initial`, with its old records still stored but never folded. You write no filter for this. The Race's `raceId` is a different thing: it separates races within one instance.

Disabling or removing stops the Box's digests and aborts any in flight. A Box with other background work cancels it when `ConversationMemoryChange.stoppedBox` names it, as `src/server/memory/sync.ts` does for Memory.

A new Chat starts with the Boxes whose descriptor says `startsEnabled: true`, which today are the Author Note and Memory. No Box is exempt from removal. The writer manages all of this in the Box manager in the composer.

## Worked example: the Race

The Race uses most of the contract. Its files are `src/server/box/race.ts` (the Box), `race-engine.ts` (the simulation), `src/shared/contract/race.ts` (schemas), `src/shared/race-moves.ts` (Move rules shared by window and engine), `src/shared/race-data.ts` (bundled courses, roster, seeded random), and `src/client/box-windows/Race*.tsx` (the window).

### Descriptor and type

```ts
race: {
  label: "Race", role: "system", startsEnabled: false,
  setup: setupOf(raceSetup, initialRaceSetup),
  record: raceRecord,
  moves: movesOf(raceMove, MAX_RACE_MOVES, raceMoveLabel),
},
```

```ts
satisfies Box<RaceSetup, Pick<RaceInput, "seed" | "intent" | "withdrawn">, never, never, RaceRecord, RaceState | null, RaceMove>
```

Setup is `RaceSetup`. Dependencies are the seed, intent and withdrawn names. It has no trace and no injected services. Records are `RaceRecord`, state is `RaceState | null`, and Moves are `RaceMove`. It has no `decision`, so it does not digest and serves its own `read`.

### Setup

`raceSetup` holds `raceId`, the course, metres per Stretch, the slots, Auto mode and `phase` (`setup` or `running`). Whether the race finished is folded state, not setup. "Start race" saves the draft with a new `raceId` and `phase: "running"`. "New race" saves `initialRaceSetup` with another new `raceId`. `setupError` rejects course or field changes once a race is running, so mid-race edits fail with a message and do not corrupt state.

### Dependencies

```ts
dependencies: ({ seed, intent, cast }, setup) => ({
  seed, intent, withdrawn: setup.slots.flatMap(({ name, participantId }) => participantId !== undefined && !cast.some(({ id }) => id === participantId) ? [name] : []),
}),
```

`withdrawn` lists slotted Cast Runners whose Participant has left the Cast. Only the host reads the Cast, so the Race takes it from `CaptureRead`.

### Records and fold

A record is `{ raceId, stretch, outcome, after }`. `after` is the complete state after the Stretch: standings, energy, Hidden intents and the replay so far. `foldRace` returns `after` when it belongs to the current `raceId`. Old races stay in history and never leak into a new one. `currentRaceState` treats state from another `raceId` as the initial state.

The Race has no digest, so it gets no override editor and its slots normally hold only `automatic`. The generic `set-box-record` command would still accept a Race override, as it does for any Box with a `record` descriptor.

### Advance

`advanceRace` is a pure function of setup, state, Moves, seed and intent. All randomness comes from `raceRandom(seed)`, which is why a swipe repeats the outcome and a re-roll draws a new one. One call:

1. Returns nothing unless the race is running with at least two Runners. A continue intent advances only under Auto mode, and stops at Auto's `until` distance.
2. Resolves the writer's Moves in order with `checkRaceMove`, so a Move that went illegal fizzles with a reason.
3. Has engine AI decide for every other Runner from Running style, stats, energy and position.
4. Simulates the Stretch in 20 fixed steps. Stretches shorten to at most 100 m in the final 400 m.
5. Picks two or three salient events, weighted double for Cast Runners, plus foreshadowing and reveals for Hidden intents.
6. Writes the item: course, Stretch range, standings, events, Move results, intents and "Narrate only this Stretch. Do not go past N m."

After the line it runs one Results Stretch, with finishing order, margins, outstanding reveals and "Narrate the finish." From then on it returns no item and no record until a new race starts.

`raceBox.advance.run` wraps that for Hold and withdrawal. A lone legal Hold on a respond turn returns a pinned item and no record, so the race stands still. A Hold that Auto mode made illegal reaches the engine and fizzles while the Stretch runs. A withdrawal is announced once and persisted as a record even when no Stretch runs, including on a Hold turn, so it does not repeat on every Hold. A field cut below two Runners ends in a walkover.

Every item is pinned at priority 100. The Stretch must reach the model whole or not at all. `fingerprint` returns the dependencies, so a change in the seed or the withdrawn names marks a preview stale.

### Moves

The window offers each Move with its projected cost and odds, from `checkRaceMove(setup, state, staged, move)`. Moves act on the human seat's Runner, or as orders to a chosen Runner when the human seat is not racing. They are off while Auto is advancing the race: always under `on`, and until the stopping point under `until`. From that point on, legal Moves are offered again. `render` turns a Move into `(Race Move: Special Week tries to overtake.)` in history. If the Race is later disabled or removed, history shows the chip label `⚡ Overtake · Special Week` instead.

### Data scopes

- Library: roster avatars, keyed `avatar:<name>`, set from the window.
- Character: `stats`, saved back from a stat sheet.
- Participant: `stats`, copied from the Character when it seeds the Participant and edited by the writer afterwards. `readRaceCastStats` decodes them and fails loudly on a bad row.

Avatars go through `boxData`. A stat sheet's `stats` ride as `writes` on the `set-box-setup` that adds the gate, so the gate and its stats land together.

### Window

`RacePanel` shows setup and stat sheets before the start, then the SVG oval and Move controls while running, and the replay after the finish. `readRace` sends the spectator state and its own status line, and sends the replay and Hidden intents only once `state.finished` is true, so the window cannot spoil them. `RaceDockTab` shows that status.

### Tests

`race.test.ts` checks determinism for equal inputs and the fold across `raceId`s. `race-withdrawal.test.ts` covers withdrawals. `e2e/race*.spec.ts` starts a race, advances it with Moves, swipes for the same outcome and re-rolls for a new one, all asserted through Prompt Plan inspection.
