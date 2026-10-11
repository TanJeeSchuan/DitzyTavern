# Writing a Box

A Box is a compiled-in story feature. It owns what its state means. The host stores that state, orders it along the story and routes it to the right place, and never interprets it. This guide covers the contract as built and the host files a new Box has to touch, with the Race as the worked example. See [ADR-0050](../adr/0050-build-story-features-as-boxes.md) for why Boxes exist and [the spec](spec.md) for the product decisions.

The host is not generic yet. Every Box is wired in by hand at a fixed set of places, so adding one means editing those places. The checklist below names each one. When a second Box needs something only one Box uses today, such as a digest or a lens, generalize the host code at that point and not before.

## Add a Box

Do these in order. A step is done when its check passes.

1. **Name it.** Add the id to `boxIds` in `src/shared/contract/box.ts`. The id gives you the preset reference and the data namespace, both `box:<id>`. Add it to `defaultBoxIds` only if every new Chat should start with it enabled.
2. **Give it a preset block.** Add a label to `singleUseReferenceLabels` and a role to `defaultOutgoingRoles` in `src/shared/contract/prompt-preset.ts`, and the reference to the add-block list in `src/client/workspace/prompt-preset/PromptPresetRecipeEditor.tsx`. The database needs no migration, because its constraints accept any `box:` reference. `installDefaultPresetBoxes` adds the block to the Default preset only when it creates a fresh database. Existing presets, the Default one included, get it through the add-block action, so add it there by hand or start from a fresh database. Done when `bun run typecheck` passes and the block appears in the add-block menu.
3. **Write the Box.** Create `src/server/box/<id>.ts` exporting an object that `satisfies Box<...>` from `src/server/box/contract.ts`. Declare only the hooks you need (see [Hooks](#hooks)). Done when it typechecks.
4. **Capture it.** Add a line to `captureBoxes` in `src/server/box/registry.ts`. Build its `AdvanceInput` from what the host already read for this Generation: setup, folded state, Moves, and whatever goes in `dependencies`. Gate it with `runs("<id>")`. Done when an enabled Box with an enabled block shows its item in Prompt Plan inspection.
5. **Wire each hook you declared.** Each hook section below ends with a "Host wiring" line listing the files to touch. Done when every declared hook has its wiring.
6. **Handle stopping.** If the Box runs background work, cancel it when `ConversationMemoryChange.stoppedBox` names it (`queueBoxDigests` and `src/server/memory/sync.ts` do this). If it keeps Chat-scoped data outside `conversation_data` and `participant_data`, delete that data in `setBoxState` when it is removed. Done when disabling the Box mid-work leaves no late write.
7. **Test it.** Write an e2e spec in `e2e/` per user flow, asserting through Prompt Plan inspection. Add unit tests only for logic that can really fail, such as determinism for a given seed or a fold across ids. Run `bun run check` and `bun run test:e2e` through `flock /tmp/ditzy-heavy.lock`. Done when both pass.

## Hooks

The contract lives in `src/server/box/contract.ts`:

```ts
interface Box<Setup, Dependencies = undefined, Trace = never, Services extends keyof BoxServices = never, Rec = never, State = undefined, Move = never> {
  inject?: readonly Services[];
  setup?: { schema: TSchema; initial: Setup };
  moves?: { schema: TSchema; render(move: Move, author: string): string };
  records?: {
    schema: TSchema;
    initial: State;
    fold(state: State, record: Rec): State;
    digest?: { window: number; run(window: DigestWindow, ctx: DigestContext): Promise<Rec> };
  };
  advance?: {
    trace?: TSchema;
    run(input: AdvanceInput<Setup, Dependencies, State, Move>, ctx: BoxContext<Services>): Promise<AdvanceResult<Trace, Rec>>;
    fingerprint?(input: AdvanceInput<Setup, Dependencies, State, Move>): string;
  };
  status?(setup: Setup, state: State): string | null;
}

type AdvanceInput<Setup, Dependencies, State, Move> = { setup: Setup; dependencies: Dependencies; state: State; moves: readonly Move[] };
type AdvanceResult<Trace, Rec> = { items: readonly BlockItem[]; allowance?: number; trace?: Trace; record?: Rec };
type BlockItem = { text: string; priority: number; pinned?: boolean };
```

Every hook is optional. The window and the lens are React, so they live in a client registry, `src/client/box-windows/registry.tsx`, and not on this object.

### `advance`

The Box's turn in a Generation. The host calls `advance.run` once per Generation for each captured Box, all in parallel, during preparation. That covers Send, Continuation, Sibling and Prompt Plan preview. Boxes never see each other's results.

What the host does with the result:

- `items` go into the Box's preset block and through the Prompt Macro pass. The host admits pinned items first. It then admits unpinned items whole, by descending `priority`, while they fit `allowance`, or the remaining context when there is no allowance. Pinned items ignore the allowance but count toward the context limit, and a plan that overflows it raises `PromptBudgetExceededError`. The host records a reason for each unpinned item (`admitted`, `allowance`, `oversized` or `context-limit`), but only Memory's inspection shows them today.
- `record` is held on the Active Generation with the Box instance captured for it, and written to the new Variant as `{ automatic: record }` under that instance when it resolves. The host throws if the Box returns a record without declaring `records`, and asserts the record against `records.schema`. Add the Box to `boxRecords` in `src/shared/contract/box-generation.ts`. Acceptance parses records with `Value.Parse`, which strips undeclared keys, so an unregistered record vanishes without an error.
- `trace` is asserted against `advance.trace` when the Box declares that schema. Without one, the host skips validation. Only Memory's trace has a consumer today. It becomes the Generation's Memory activation record. A new Box's trace goes nowhere until you add a consumer.

`dependencies` carry everything else the Box needs, which the host reads at capture: the Variant's seed stream, the Generation intent, Cast names. Each Box picks its own `Dependencies` type. The Race takes `{ seed, intent, withdrawn }`, the Phone takes `{ human, contacts }`, and Memory takes its whole recall snapshot.

Intent is `"continue"` for a Continuation, and for a Sibling whose preceding Message the model wrote. Everything else is `"respond"`.

`fingerprint` adds inputs the host cannot see to the preview fingerprint. The host already fingerprints the whole preparation snapshot, seed included, plus each Box's setup, state and Moves. If the fingerprint changes between preview and send, the send fails with "The Prompt Plan is stale". Memory returns its freshness fingerprint. The Race returns its `dependencies`, so a change in the seed or the withdrawn names marks a preview stale.

Pilot consumers. All five Boxes declare `run`. The Author Note returns one pinned item, or none when the note is blank. Memory returns prioritized claims under its `allowance`, plus a `trace`. The Race returns one pinned Stretch item and a `record`.

### `inject`

Lists the provider services `ctx` exposes: `llm`, `decide` and `embed`. `ctx` always has `signal`, which aborts when the server shuts down. The host builds `ctx` from exactly the declared keys, so a Box that does not declare `embed` cannot call it.

Pilot consumer. Memory declares `["decide", "embed"]` for its relevance pass and embedding query.

Host wiring: none.

### `setup`

The Box's per-Chat configuration, stored in `conversation_data` under `box:<id>`, key `setup`. A Chat with no stored setup reads `initial`. A stored value that fails `schema` is an error that tells the writer to clear the namespace. There is no migration path, by design.

The client sends `set-box-setup`. The handler validates anything the schema cannot express, for example impossible calendar dates or a course change mid-race, and throws `InvalidConversationCommandError` with a message the window shows.

Pilot consumers. Author Note (the note text), World Clock (start, era, climate, hemisphere, unit), Race (course, field, Auto mode, phase).

Host wiring: add the schema to `boxSetups` in `src/shared/contract/box.ts`, a `decodeSetup` line to `readBoxSetups` in `src/server/box/setup.ts`, an action to the `set-box-setup` union in `src/shared/contract/conversation-schema.ts`, and extra validation to `src/server/conversation/commands/set-box-setup.ts`.

### `moves`

Actions the writer attaches to a Human-authored Message. A Box window stages Moves into the composer through `MoveStaging`, and they show as chips the writer can drag to reorder or remove. A Message may hold only Moves. The host stores each Box's list in order in `messages_data` under `box:<id>`, key `moves`, and decodes them on read.

The host calls `render(move, author)` for the Generation prompt, Lore scanning and Generation-time Memory recall. Background Memory extraction and Box digests read raw Variant prose without Moves, so a digest never sees what the writer staged. The Message's text becomes each Move rendered, one per line, then the prose. When the Box is not enabled in the Chat, the host uses the Move's chip label instead, so removing a Box never breaks past Messages.

The Moves `advance` receives come from the triggering Human-authored Message: the one being sent, or the one a Sibling answers. A Continuation gets none. Newly submitted Moves for a Box that is not enabled are rejected, and the composer drops staged Moves for a Box that stops being enabled. A Send that retries an existing Human-authored Message keeps the Moves already stored on it. `set-message-moves` replaces a past Message's Moves, and regenerating its reply then replays the turn.

Validate staged Moves with the same function the Box uses at resolution, given the Moves staged before. The Race's `checkRaceMove(setup, state, earlier, move)` returns either `{ legal, cost, odds }` or `{ legal: false, reason }`. The window uses it to offer only legal Moves, and `advanceRace` uses it to fizzle a Move that turned illegal.

Pilot consumers. Race (Overtake, Conserve, Spurt, Hold, rendered as `(Race Move: … )`) and Phone (outgoing texts, rendered as `<sms>` from the author).

Host wiring: add the schema to `boxMoves` in `src/shared/contract/box-generation.ts`, the id to `moveBoxIds` and a line to `renderMoves` in `src/server/box/moves.ts`. `MoveChips` in `src/client/story/MoveChips.tsx` destructures and rebuilds each Box's list by name, so add the new list there, or editing one Box's chips drops the new Box's Moves. `src/client/workspace/useGenerationController.ts` filters staged Moves by enabled Box and rebuilds them on a seat change, so add the new Box to both.

### `records`

Facts the story has settled, one per Variant. State is never stored. The host folds it each time it needs it: `fold` over the effective record of each selected Variant, in Message order, starting from `initial`. The effective record is the Writer override if there is one, else the automatic result. See [History](#history) for what that means for your design.

Records come from two places. `advance` returns one at Generation time, as the Race does. `records.digest` reads finished prose later, as the World Clock does.

Pilot consumers. World Clock (`{ minutes, weather }` per passage) and Race (`{ raceId, stretch, outcome, after }` per Stretch).

Host wiring: add a record slot schema to `boxRecordSlots` in `src/shared/contract/box-generation.ts`, and the folded state to `RecordStates` and `foldRecordStates` in `src/server/box/records.ts`. Writer overrides use `set-box-record` and `reset-box-record`, which today accept only `world-clock`.

### `records.digest`

Background reading of prose the story has settled. The host queues a digest for a selected Variant when it resolves, when it becomes selected without a record for its current text, or when its text is edited. It skips Variants that are empty or still generating. The window's catch-up action queues every selected Variant without a record.

Two workers drain the queue, live jobs before catch-up jobs. A newer job for the same Variant aborts the older one. Jobs live in memory, so a restart loses them. The passage is queued again when it is next selected, resolved or edited, or by catch-up. Generations never wait for digests.

`run` gets `{ passage, preceding, seed }`. `seed` is this Box's stream of the Variant's seed. `preceding` holds up to `window` Messages before the passage. The history read behind it, `readSelectedPathForMemory`, returns at most five Messages including the passage, so `window` is capped at four. A `window` of 0 slices nothing off and returns every Message that read found, up to four. `ctx.decide(state, questions)` asks the Box's own Decision Model selection, which lives in `library_data` under `box:<id>`, key `decision`. Without a selection no digest runs. The host writes the result as the slot's `automatic` value with a hash of the digested text. It discards the result if the text changed, a newer job replaced it, the Box stopped being enabled, or the selection went away.

Pilot consumer. World Clock asks two `choice` questions, elapsed time and weather, and draws exact minutes inside the chosen bin from `seed`.

Host wiring: the digest path is written for the World Clock alone. A second digesting Box generalizes `src/server/box/digest.ts`, which names the World Clock in literals, along with `digestBoxId` and `digestBoxes`, the record helpers in `records.ts` typed to `WorldClockRecord`, the catch-up routes in `src/server/contract/box-window.ts` that always return `readWorldClock`, and the Decision Model settings client in `src/client/box-decision-settings.ts` and its panel in `ConnectionSettingsPanel.tsx`.

### `status`

A one-line summary for the dock, or `null`. The host does not call it during Generation. The Box's window read calls it and returns the string, and the client's `DockTab` shows it.

Pilot consumers. World Clock (`8:41 AM · ☀️ 3°C`). Race (`🏇 1500m · 3rd`, `🏁 1st · Special Week`), whose read calls `raceStatus` with the human seat's Runner. The Phone has no server `status`: its unread count is client view state, so its `DockTab` counts it in the browser.

### Window (client)

Register a windowed Box in both `windowBoxIds` and `boxWindows` in `src/client/box-windows/registry.tsx`. The launcher and the window layer iterate `windowBoxIds`, and `boxWindows` gives each one an `icon`, a `size` in rem, a `DockTab` and a `Panel`. The composer shows a launcher button for each enabled Box. Windows drag but do not resize, several can be open at once, and minimizing turns a window into its `DockTab`. Open state, minimization and position are stored per Chat in local storage. On narrow layouts a window becomes a full-screen layer.

A `Panel` gets the `ConversationSummary`, which carries `boxSetups` and `boxes`. It also gets `disabled`, `staging` for Moves, and `onConversationChange`. It loads anything else from a read route in `src/server/contract/box-window.ts`, backed by a function in `src/server/box/window.ts`, with a response schema in the shared contract and a client loader such as `src/client/race.ts`. Send the read only what a spectator may see. The Race read returns its replay and Hidden intents only after the finish.

Pilot consumers. World Clock, Race and Phone. The Author Note and Memory keep their side panels.

### Lens (client)

`lens.strip(text, names)` splits a Variant's prose into prose segments and lifted segments, and `lens.View` renders a lifted one. The story view applies it. The prompt keeps the raw markup.

Pilot consumer. Phone lifts `<sms from="…" to="…">…</sms>` when both names are the human-controlled Participant and a Cast member, and leaves anything else as raw text.

Host wiring: `src/client/story/LensedProse.tsx` and `StoryStage.tsx` hard-code the Phone, and `BoxWindowDefinition.lens` in `src/client/box-windows/registry.tsx` is typed to Phone names, segments and texts. A second lens generalizes all three.

## Storage

| Scope | Table | Written by |
|---|---|---|
| Library | `library_data (namespace, key, value)` | Box window, through `put-box-data` |
| Character | `character_data (character_id, namespace, key, value)` | Box window, through `put-box-data` |
| Participant | `participant_data (participant_id, namespace, key, value)` | Copied from Character data when a Character seeds a Participant, then Box window through `put-box-data` |
| Conversation | `conversation_data` | Host, as `enabled`, `instance` and `setup` |
| Message | `messages_data` | Host, as `moves` |
| Variant | `message_variant_data` | Host, as `record:<instance>` from `advance`, digests and Writer overrides |

The namespace is always `box:<id>`. `put-box-data` takes a Box id and derives the namespace from it, so no command can name a raw namespace. The host does not check which window sent it, so each window must pass its own id. Values are strings. The Box decodes its own and treats a value that fails its schema as an error, never as a row to skip. Character data and Participant data are independent after the copy, so a later Character edit never reaches an existing Participant.

Each Variant also holds one Generation seed, shared by every Box, under namespace `box`, key `seed`. `boxSeed(seed, id)` gives each Box its own stream. A Variant with no seed, such as an imported one, uses `variant:<id>`.

Boxes cannot add tables. A feature that needs relational queries stays in-tree code that owns its tables, like Lorebooks and, until its full port, Memory.

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

Each Box is enabled, disabled or absent in each Chat. The host stores `enabled: true | false` and an `instance` id in `conversation_data` under `box:<id>`. No row means absent. Use `isBoxEnabled` or `readBoxStates` from `src/server/box/setup.ts` to check, and `enabledBoxConversations` for background work that spans Chats.

- **Enabled.** The only state where the Box runs. It is captured into the Prompt Plan when its preset block is also enabled, queues digests, accepts Moves, and shows its launcher, window, dock tab and lens. Memory is the one exception to the block rule: it is captured even with its block disabled, to record activation evidence without items.
- **Disabled.** Nothing runs and nothing reaches the prompt. Setup and data stay. Re-enabling picks up where the Box left off.
- **Absent.** Removing deletes the Box's `conversation_data`, its instance included, and this Chat's `participant_data` in its namespace (and Memory's per-Chat settings). Library and Character data, Variant records and Message Moves stay, because history is immutable.

Each insert gives the Box a new instance id; disabling keeps it. The host stamps every record with the instance that wrote it, by storing the slot under key `record:<instance>`, and folds only the current instance's slots. A reinserted Box therefore starts from `setup.initial` and its initial state, with its old records still stored but never folded. You write no filter for this. The Race's `raceId` is a different thing: it separates races within one instance.

A new Chat starts with `defaultBoxIds` enabled, which today are the Author Note and Memory. No Box is exempt from removal. The writer manages all of this in the Box manager in the composer. Disabling or removing returns `stoppedBox` on the change, which is your hook to cancel background work.

## Worked example: the Race

The Race uses most of the contract. Its files are `src/server/box/race.ts` (the Box), `race-engine.ts` (the simulation), `src/shared/contract/race.ts` (schemas), `src/shared/race-moves.ts` (Move rules shared by window and engine), `src/shared/race-data.ts` (bundled courses, roster, seeded random), and `src/client/box-windows/Race*.tsx` (the window).

### The type

```ts
satisfies Box<RaceSetup, Pick<RaceInput, "seed" | "intent" | "withdrawn">, never, never, RaceRecord, RaceState | null, RaceMove>
```

Setup is `RaceSetup`. Dependencies are the seed, intent and withdrawn names. It has no trace and no injected services. Records are `RaceRecord`, state is `RaceState | null`, and Moves are `RaceMove`.

### Setup

`raceSetup` holds `raceId`, the course, metres per Stretch, the slots, Auto mode and `phase` (`setup` or `running`). Whether the race finished is folded state, not setup. "Start race" saves the draft with a new `raceId` and `phase: "running"`. "New race" saves `initialRaceSetup` with another new `raceId`. `raceSetupError` in the `set-box-setup` handler rejects course or field changes once a race is running, so mid-race edits fail with a message and do not corrupt state.

### Capture

```ts
...runs("race") ? [captureBox("box:race", raceBox, {
  setup: setups.race, state: states.race, moves: generation.moves.race ?? [],
  dependencies: { seed: boxSeed(generation.seed, "race"), intent: generation.intent, withdrawn: generation.withdrawn },
})] : [],
```

`withdrawn` lists slotted Cast Runners whose Participant has left the Cast. The host computes it, because only the host reads the Cast.

### Records and fold

A record is `{ raceId, stretch, outcome, after }`. `after` is the complete state after the Stretch: standings, energy, Hidden intents and the replay so far. `foldRaceRecords` keeps only records for the current `raceId`, and `foldRace` returns `after`. Old races stay in history and never leak into a new one. `currentRaceState` treats state from another `raceId` as the initial state.

The Race has no Writer override, so its slot is `{ automatic }` and the fold reads `automatic` directly.

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

Every item is pinned at priority 100. The Stretch must reach the model whole or not at all.

### Moves

The window offers each Move with its projected cost and odds, from `checkRaceMove(setup, state, staged, move)`. Moves act on the human seat's Runner, or as orders to a chosen Runner when the human seat is not racing. They are off while Auto is advancing the race: always under `on`, and until the stopping point under `until`. From that point on, legal Moves are offered again. `render` turns a Move into `(Race Move: Special Week tries to overtake.)` in history. If the Race is later disabled or removed, history shows the chip label `⚡ Overtake · Special Week` instead.

### Data scopes

- Library: roster avatars, keyed `avatar:<name>`, set from the window.
- Character: `stats`, saved back from a stat sheet.
- Participant: `stats`, copied from the Character when it seeds the Participant and edited by the writer afterwards. `readRaceCastStats` decodes them and fails loudly on a bad row.

All three go through `put-box-data`.

### Window and status

`RacePanel` shows setup and stat sheets before the start, then the SVG oval and Move controls while running, and the replay after the finish. `readRace` sends the spectator state, and sends the replay and Hidden intents only once `state.finished` is true, so the window cannot spoil them. The dock shows `raceStatus`.

### Tests

`race.test.ts` checks determinism for equal inputs and the fold across `raceId`s. `race-withdrawal.test.ts` covers withdrawals. `e2e/race*.spec.ts` starts a race, advances it with Moves, swipes for the same outcome and re-rolls for a new one, all asserted through Prompt Plan inspection.
