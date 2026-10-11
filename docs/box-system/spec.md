# Box system

## Problem Statement

Every story feature that keeps state and feeds Generations is built from scratch. The Author Note added a Conversation column, a preset reference, a unique index and a compiler branch. Memory added all of those plus its own worker pool, epoch cancellation and catch-up runs. Writers want more features of this kind: an in-world clock, a phone, a race the story follows. Each would repeat the same plumbing. Each would also have to rediscover how its state behaves on swipe, on an earlier selection change, and during preview, which Macro State already settled once.

Writers also want features that are more than prompt text: something to watch, controls to act through, and outcomes the prose has to respect, without breaking the rule that the Selected narrative path is the story.

## Solution

A **Box** is a compiled-in story feature with opaque state and a fixed set of optional hooks. The host stores, orders and routes Box data and never interprets it. A Box turns its state into prompt items through its own preset slot, may resolve Moves the human attached to a Message, may read finished prose in the background, and may render a floating window that minimizes to a dock. History follows the existing Macro State rule: records are resolved values retained with Variants and folded along the Selected narrative path.

The pilot builds the whole contract through five Boxes, in order: Author Note, Memory, World Clock, Race and Phone.

See [ADR-0050](../adr/0050-build-story-features-as-boxes.md).

## User Stories

### Using Boxes

1. As a writer, I want each Box to have its own block in my Prompt Preset, so that I decide where its content sits in the prompt.
2. As a writer, I want new Default presets to include every Box block, so that Boxes work without preset editing.
3. As a writer, I want to add a missing Box block to an existing preset with one action, so that older presets can use new Boxes.
4. As a writer, I want Box content shown in Prompt Plan inspection, so that I can see exactly what each Box told the model.
5. As a writer, I want a swipe to keep a Box's outcome and rewrite only the prose, so that "write this differently" never changes what happened.
6. As a writer, I want a re-roll that draws a new outcome, so that "make something else happen" is a separate choice.
7. As a writer, I want Box state to follow the Variants I select, so that alternatives never leak into each other.
8. As a writer, I want to override what a Box worked out for a passage, and reset it later, so that I keep editorial control.
9. As a writer, I want Box windows I can drag, keep open side by side, and minimize to a dock beside the composer, so that a Box stays in view without covering the story.
10. As a writer, I want a minimized Box to show a one-line status, so that I can follow it without opening it.
11. As a writer, I want window positions remembered per Chat, so that each story keeps its layout.
12. As a writer, I want to insert, disable and remove any Box per Chat, so that each story runs only the features it uses.
13. As a writer, I want a disabled Box to keep its setup and pick up where it left off when I enable it again, so that pausing a feature costs nothing.
14. As a writer, I want removing a Box to keep the story's history intact, so that past passages still read the same.

### Moves

12. As a writer, I want a Box to put Moves into the composer as chips, so that I can combine an action with my own words.
13. As a writer, I want to reorder and remove staged Moves before sending, so that I control the order they resolve in.
14. As a writer, I want to send Moves without any text, so that a turn can be a pure action.
15. As a writer, I want my Moves shown on my Message in the story, so that I can see what I chose.
16. As a writer, I want editing a Message's Moves and regenerating to replay the turn, so that I can try another choice.

### World Clock

17. As a writer, I want the Chat's in-world date, time and weather shown as `8:41 AM | 🗓️ Saturday, December 20, 2025 AD | ☀️ Clear, 3°C`, so that the story always knows when and where it is.
18. As a writer, I want time to advance from what each passage says happened, so that I never have to keep the clock by hand.
19. As a writer, I want weather taken from the prose and forgotten after a day without mention, so that a storm never lasts a week just because nobody looked up.
20. As a writer, I want to set the start date, era suffix, climate, hemisphere and temperature unit, so that the clock fits my setting.
21. As a writer, I want to correct a passage's elapsed time or weather, so that a misread passage does not skew everything after it.
22. As a writer, I want the World Clock off in each Chat until I turn it on, and its digests idle until I choose a Decision Model, so that nothing reaches the prompt or runs that I did not configure.

### Race

23. As a writer, I want to set up a race from a list of well-known courses or a custom distance, surface and direction, so that races fit my story.
24. As a writer, I want to add Cast members to the race and fill the remaining gates from the bundled roster, so that a full field is quick to assemble.
25. As a writer, I want a Cast member's race stats to come from her Character and carry across races, so that training means something.
26. As a writer, I want the race to advance one Stretch per Generation and shorten Stretches near the finish, so that the climax gets space.
27. As a writer, I want Moves such as overtake, conserve and spurt for the Runner I control, with their cost, so that each turn is a real decision.
28. As a writer, I want Auto mode for the whole race or until a set distance from the finish, so that I can watch instead of play.
29. As a writer, I want Runners' plans foreshadowed and revealed when they pay off, so that the race reads like sports drama rather than a report.
30. As a writer, I want the race window to show only what a spectator could see until the finish, and then a full replay, so that nothing is spoiled.
31. As a writer, I want the narrator told what happened in each Stretch and forbidden to go further, so that the model never finishes the race early.

### Phone

32. As a writer, I want texts between my character and Cast members shown as phone threads instead of inside the prose, so that texting reads like texting.
33. As a writer, I want to text from the phone window, so that a turn can be only a text.
34. As a writer, I want an unread count in the dock, so that I notice when someone texts me.

### Writing Boxes

35. As a developer, I want an authoring guide with the Race as its worked example, so that I can write a new Box without reading the host.

## Implementation Decisions

### Contract

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

type AdvanceInput<S, D, St, M> = { setup: S; dependencies: D; state: St; moves: readonly M[] };
type AdvanceResult<T, R> = { items: readonly BlockItem[]; allowance?: number; trace?: T; record?: R };
type BlockItem = { text: string; priority: number; pinned?: boolean };
type DigestWindow = { passage: DigestPassage; preceding: readonly DigestPassage[]; seed: string };
type DigestContext = { signal: AbortSignal; decide(state: DecisionJson, questions: DecisionQuestions): ReturnType<typeof requestDecisions> };
```

- Every hook is optional. `advance` may return a `record` only when the Box declares `records`; the host throws otherwise.
- The id is the Box's entry in `boxIds`, not a field. Boxes are wired into the host by hand at fixed places: capture, setup decoding, record folding, Moves rendering and the window registry. `docs/box-system/authoring.md` lists them.
- `dependencies` carry the host-read inputs a Box needs beyond setup, state and Moves, each Box choosing its own type: the Race takes its seed stream, the Generation intent and withdrawn Runners; the Phone takes the human and contact names; Memory takes its recall snapshot.
- `ctx` exposes only the services named in `inject`, plus an abort signal. A Box reads its data scopes through what the host captures into `dependencies`, or through its window read.
- The window and the lens are React, so they live in the client registry `boxWindows` as `{ icon, size, DockTab, Panel, lens? }`, with `size` in rem.
- Every value crossing the wire or the database is decoded against the declared schema. With no backward compatibility, a value that fails to decode after a schema change is an error; clearing the namespace is the remedy.
- `trace` is asserted against `advance.trace` when the Box declares it, and is never folded. Memory's trace becomes the Variant's Memory activation record; no other trace has a consumer.

### Storage scopes

| Scope | Table | Written by |
|---|---|---|
| Library | `library_data (namespace, key, value)` | Box window, through a host command |
| Character | `character_data (character_id, namespace, key, value)` | Box window, through a host command |
| Participant | `participant_data (participant_id, namespace, key, value)` | Copied from Character data on seeding; Box window afterwards |
| Conversation | `conversation_data` (existing) | Host, as `enabled` from the Box manager and `setup` from the Box window |
| Message | `messages_data` (existing) | Host, as `moves` from staged Moves |
| Variant | `message_variant_data` (existing) | Host, as `record` from `advance` and `digest` results |

- The namespace is `box:<id>`. A Box cannot read another Box's namespace.
- Variant data per Box holds the record slot under key `record`: `{ automatic?, writer?, source? }` for the World Clock, where `source` hashes the digested text, and `{ automatic }` for the Race. Each Variant also stores one Generation seed shared by all Boxes, under namespace `box`, key `seed`; a Box derives its own stream by hashing the seed with its id. A Variant without a seed, such as an imported one, uses `variant:<id>` as its seed.
- Window writes to Library, Character and Participant data go through the `put-box-data` command, which takes the Box id rather than a namespace. Values are strings the Box decodes on read.
- Boxes cannot add tables. Configuration edits apply atomically under ADR-0023.

### History semantics

- State is the Box's fold over effective records (`writer ?? automatic`) of selected Variants in Message order.
- Records are resolved values. An earlier selection change or override never re-evaluates, invalidates or excludes later records.
- A Sibling reuses the Moves of the Human-authored Message it answers and inherits the seed of the Variant selected at its Message. Re-roll is a Sibling with a new seed.
- A Writer override replaces the effective value without rewriting prose. Reset removes it. A later automatic result never displaces it.
- Completed Variants keep their captured inputs. Digest results arriving later change current derivation only.

### Generation lifecycle

1. **Capture.** For each enabled Box with an enabled preset block, the host reads setup, folded state, the Moves on the triggering Human-authored Message (none for a Continuation), and the Box's dependencies, such as its seed stream and the Generation intent. The intent is `continue` for a Continuation and for a Sibling whose preceding Message the model wrote, else `respond`. Memory is captured whenever it is enabled in the Chat, even with its block disabled, so its activation evidence is still recorded; it then contributes no items.
2. **Advance.** All Boxes run in parallel. Record and trace are held on the Active Generation and copied to the Variant on resolution.
3. **Admit.** Items enter the Box's block and pass through the Prompt Macro pass. Unpinned items are admitted whole by descending priority within `allowance`, or within remaining prompt space when no allowance is given. Pinned items sit outside the allowance, count toward the total, and an over-budget plan raises the existing `PromptBudgetExceededError`.
4. **Preview.** The captured plan is sent as inspected. The host fingerprints the whole preparation snapshot, seed included, with each Box's setup, state and Moves; a Box `fingerprint` adds dependencies the host cannot see. A mismatch reports the plan as stale. Admission reasons per item reach inspection only for Memory.
5. **Digest.** When a selected, non-empty Variant resolves, becomes selected without a record for its current text, or has its text edited, the host queues its Boxes' digests. The queue runs at most two workers, puts live jobs before catch-up runs, and cancels superseded work by epoch. Jobs live in memory; work lost on restart is queued again on the next selection, resolution or edit, or by catch-up. Results fill the `automatic` slot, and are discarded if the text changed, the job was superseded, the Box stopped being enabled, or its Decision Model selection went away. Generations never wait for pending digests.

### Lifecycle per Chat

- Each Box is **absent**, **enabled** or **disabled** in each Chat, stored by the host as `enabled` under `box:<id>` in `conversation_data`. An absent Box has no row.
- Only an enabled Box runs: it contributes to the Prompt Plan, queues digests, accepts staged Moves, and shows its window and dock tab. A disabled or absent Box does none of these.
- **Insert** enables a Box. **Disable** keeps its Chat-scoped data. **Remove** deletes, after confirmation, its `conversation_data` and this Chat's `participant_data` in its namespace, plus Memory's per-Chat settings for Memory. It keeps Library and Character data and every Variant record and Message Move, because history is immutable. Inserting a removed Box again starts it from its initial setup; its retained records still fold into state unless the Box filters them, as the Race does by `raceId`.
- Disabling or removing reports `stoppedBox` on the Conversation change, which cancels the Box's background work.
- While a Box is absent or disabled, a stored Move enters history as its chip label, such as `📱 Elara: hi`, instead of through `moves.render`.
- A new Chat starts with the Author Note and Memory enabled and every other Box absent. No Box is exempt from removal.
- A Box manager in the composer's Box launcher lists every Box with its state, a switch, and Remove.
- Per-Box on/off settings are replaced by this lifecycle. The World Clock's `enabled` setup field is removed.

### Prompt Preset

- A Box block has `reference = 'box:<id>'`, with a partial unique index on `(preset_id, reference)` for `box:` references. This replaces the `author-note` and `memory` references and their indexes.
- New Default recipes include every Box block. Existing presets gain one through an explicit add action, as in ADR-0048.
- A Box with nothing to say, or that is not enabled in the Chat, contributes no block. The preset decides where a Box goes; the Chat decides whether it runs.

### Moves

- A Box window stages Moves into the composer, where they show as chips above the text. Chips can be reordered by drag and removed.
- Moves are stored in order on the Human-authored Message. A Message may consist of Moves alone.
- In the story, a Message shows its Moves as chips. In history sent to the model, each Move is replaced by `moves.render`.
- The Box validates staged Moves against costs projected from earlier staged Moves. At resolution a Move may fizzle, and the Box narrates the failure.

### Windows

- `window.Panel` renders in a floating window. It is draggable, not resizable, and several can be open at once.
- A minimized window becomes a tab docked at the bottom-right edge beside the composer, showing the Box icon and `status`.
- Open state, minimization and positions are client-side, per Chat, in local storage. On narrow layouts a window becomes a full-screen layer, per DESIGN.md.
- The dock tab is the Box's client `DockTab`. The World Clock and Race tabs show `status` from their window reads; the Phone counts unread texts in the client and has no server `status`.
- The Author Note and Memory keep their existing side panels; they are not Box windows.

### Author Note Box

- Setup is the note, text and Image References, in `conversation_data`. The `conversation.author_note` column is removed.
- `advance` returns one pinned item, or none when the note is blank.
- The Lore Scan Window, Semantic Trigger judging and Memory extraction still do not read it.

### Memory Box (seam port)

- `advance` is recall: capture, embedding query and Decision Model relevance, in parallel with other Boxes.
- The `MemoryActivationRecord` is its trace. The freshness fingerprint is its `fingerprint`. Claims become prioritized items under the Memory allowance.
- Memory keeps `memory_collection`, its settings tables and its own extraction queue as in-tree tables. Behavior is unchanged.
- The full port onto `digest`, records and `*_data` is [#68](https://github.com/TanJeeSchuan/DitzyTavern/issues/68).

### World Clock Box

- **Setup** (`conversation_data`): start date and time (impossible dates such as February 31 are rejected), era suffix (default `AD`), climate preset (temperate, tropical, arid, cold), hemisphere, and unit (default °C).
- **Decision Model selection** (`library_data`, key `decision`): profile, model and state token limit, global. Without one, no digest runs, and a Chat with the clock enabled contributes its last known time.
- **Digest**: one System One request per selected Variant, reading the passage and one preceding Message, with two `choice` questions:
  - elapsed time: `none, ~5m, ~15m, ~30m, ~1h, ~2h, ~4h, ~8h, overnight, ~1 day, several days`; the exact minutes are drawn within the bin from the Variant's seed;
  - weather established: `not mentioned, clear, cloudy, rain, storm, snow, fog`.
- **Records** are facts about the passage (elapsed duration, weather established), so upstream edits shift absolute time without changing them.
- **Fold**: time advances by each passage's duration. Weather is the latest established value and becomes unknown 24 in-world hours after its last mention. Temperature is derived from climate, hemisphere, season, hour and weather.
- **Calendar**: Gregorian, with weekday derived from the date.
- **Advance**: one item, `8:41 AM | 🗓️ Saturday, December 20, 2025 AD | ☀️ Clear, 3°C`. Unknown weather is omitted.
- **Window**: a passage timeline with elapsed time and weather per passage, Writer override and reset per passage, and a catch-up action that digests the existing Selected narrative path.
- **Status**: `8:41 AM · ☀️ 3°C`.

### Race Box

- **Setup** (`conversation_data`): `raceId`, course (bundled or custom distance, surface, direction), metres per Stretch, slots, Auto mode (`off`, `on`, `until <distance>`), and phase (`setup`, `running`). Whether the race finished is folded state. Starting a race and starting a new one each assign a fresh `raceId`. A running race rejects course and field changes.
- **Bundled data in code**: about eight well-known G1 courses and a roster of canon Runners, each with a name and Running style. The repository ships no art.
- **Library data**: a roster Runner's avatar as an Image reference.
- **Character data**: race stats (Speed, Stamina, Power, Guts, Wit) and Running style. They are copied to Participant data on seeding.
- **Participant data**: the Participant's own race stats, which persist across races in the Chat and change only when the writer edits them. Slotting a Cast member without stats opens a stat sheet to roll or set them. The stat sheet can save stats back to the seeding Character.
- **Slots**: Cast members, plus roster Runners drawn by "Fill field" with seeded stats biased by Running style. A roster Runner who shares a name with a Cast member is excluded.
- **Engine**: phases opening, middle, final corner and last spurt. Each Stretch is simulated in fixed internal steps. The final 400 m is split into shorter Stretches. Every Runner is driven by engine AI from Running style, stats and position.
- **Moves**: they control the human-seat Runner, or act as orders to a chosen Runner when the human seat is not racing. The Box offers only legal Moves, with projected cost and odds. A `Hold` Move skips the Stretch. Moves are disabled in Auto mode.
- **Generation intent**: a respond Generation advances one Stretch. A continue Generation advances one only in Auto mode.
- **Record**: `{ raceId, stretch, outcome, after }`, where `after` is the full post-Stretch state. The slot holds only `automatic`, since Writer overrides of race records are out of scope. The fold returns `after` for the current `raceId`. `advance` treats state from another `raceId` as initial. A withdrawal is recorded once even when no Stretch runs. A lone legal `Hold` on a respond turn produces no record unless a withdrawal must be persisted.
- **Advance item**: the course and Stretch range, standings, two or three salient events weighted toward Cast Runners, Hidden intents to foreshadow, reveals due, and "Narrate only this Stretch. Do not go past N m."
- **Results Stretch**: finishing order, margins and outstanding reveals, with "Narrate the finish." After it, the Race contributes nothing until a new race.
- **Window**: a 2D SVG oval with avatars (Portrait for Cast Runners, roster Image otherwise), positions and gaps only while running, Move controls, setup and stat sheets, and a replay of every Runner's decisions per Stretch after the finish.
- **Status**: `🏇 1500m · 3rd` while running, `🏁 1st · Special Week` when finished.
- **Withdrawal**: a Runner whose Participant leaves the Cast mid-race is withdrawn.

### Phone Box

- **Lens**: applied by the story view only while the Phone is enabled. It strips `<sms from="…" to="…">…</sms>` from the prose view when both names are the human-controlled Participant and a Cast member. Any other markup stays as raw text. The markup is kept in the prompt.
- **Threads**: one per Cast member.
- **Moves**: outgoing texts are Moves rendered as `<sms>` markup from the human-controlled Participant. A texting-only turn is a Moves-only Message.
- **Advance**: one item teaching the markup, or none when the Cast has nobody to text.
- **Unread counts**: client-side view state, never in the prompt.
- **Status**: `📱 2 unread`.

### Pilot order

1. **Author Note**: Box slot, setup, pinned items.
2. **Memory**: async `advance`, trace, fingerprint, allowance.
3. **World Clock**: `digest` queue, records, Writer override, `library_data`, window and dock.
4. **Race**: Moves, seeds, re-roll, Character and Participant data.
5. **Phone**: lens.

The authoring guide, `docs/box-system/authoring.md`, is written alongside the Race.

## Testing Decisions

- E2E covers user flows per Box against the scripted fake. Assertions go through Prompt Plan inspection, so each test pins what a Box told the model:
  - the Author Note in its slot;
  - Memory recall unchanged after the port;
  - World Clock digests scripted over `/systemone`, with an override surviving a late digest;
  - a Race started, advanced by Moves, swiped (same outcome) and re-rolled (new outcome);
  - a Phone text sent as a Moves-only turn.
- Unit tests cover only logic with real failure modes: Race determinism for equal state, Moves and seed; World Clock calendar, weekday, temperature and weather fade; the Phone lens on malformed markup; admission with pinned overflow; the Race fold across `raceId`s.
- Memory's existing tests must pass unchanged.
- No UI component tests, and no tests asserting the contract's shape.

## Out of Scope

- Full Memory port: [#68](https://github.com/TanJeeSchuan/DitzyTavern/issues/68).
- Lore as a Box.
- Room Box and 3D views.
- Bond tracking.
- Runtime loading, sandboxing, MCP Apps, Boxes shipped in Character cards, and model-generated Boxes.
- Capability grants.
- Several instances of one Box in a Chat.
- Box-to-Box reads.
- Race:
  - skills;
  - Decision Model choices in character;
  - promoting a roster Runner to a Character;
  - Cheer and Boo Moves;
  - Writer overrides of race records.
- Phone:
  - group threads;
  - contacts outside the Cast;
  - read receipts in the prompt.
- World Clock:
  - custom calendars;
  - reading explicit clock times from prose.
- A marker for Variants resolved against an earlier upstream.

## Further Notes

- Rejected approaches are recorded in ADR-0050.
- Running style names follow the game's English localization so that "Runner" stays free for Race entrants.
- Roster avatars are loaded locally, either from a gitignored folder by a seed script or through "set avatar" in the race window, because the bundled roster names canon characters whose official art cannot be redistributed in this public repository.
