# Built-in Box reference

This covers the built-in Boxes and the worked Race example; start at the [Box system entry point](README.md).

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

**Mood.** A digest asks one `choice` question over the passage and one preceding Message: `not clear`, `calm`, `warm`, `playful`, `tense`, `sad` or `eerie`. "Not clear" keeps the previous mood. The instructions are `Scene mood:` and `advance` pins the mood, `tense`, so the block reads `Scene mood:` then `tense` on the next line. Status shows the emote and word, `😬 tense`. It is a [sandboxed Box](sandboxed.md#sandboxed-boxes): `descriptor.json`, with `window.kind: "digest"`, and `logic.ts`, whose digest asks through `decide`. The generic timeline and `Status` are its whole surface.

### Worked example: the Race

The Race is a built-in [sandboxed Box](sandboxed.md#sandboxed-boxes) and uses most of its contract. Its files in `src/boxes/race/`: `descriptor.json` (the descriptor, its schemas as JSON), `logic.ts` (the hooks), `logic-engine.ts` (the simulation), `shared.ts` (its types, Move rules and status line for both logic and window), `shared-data.ts` (bundled courses, roster, seeded random), `ui.ts` and `ui-markup.ts` (the window) and `ui.css`. The loader bundles `logic.ts` into QuickJS and `ui.ts` into the frame's Worker; neither imports the SDK. Its Move label is `"{kind} · {runner}"`, each `kind` literal titled `Overtake`, `Conserve`, `Spurt` or `Hold`.

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

**Records and fold.** A record is the race after its turn: standings, energy and Hidden intents, and in `entries` the replay entry the turn added. A Stretch adds one; a withdrawal during a Hold, a walkover and the Results Stretch add none, so records stay the same size however long the race runs. Folding 200 Stretches takes at least two sandboxed calls: each chunk holds at most 100 records, also bounded by the 4 MiB JSON cap including state and setup, and gets its own deadline. `foldRace` takes the standings and intents from the last record of the current `raceId` and appends each record's entries, starting fresh when the race changes, so old races never leak into a new one. `racePhase(setup, state)` reads where the race stands, treating state from another `raceId` as initial: `setup` before the start, `running` while a Stretch is due, `crossed` once the field is over the line and the Results Stretch is due, and `finished`, a walkover included. Its `auto` says whether Auto advances the race on a continue turn. The engine, the Moves and the window all read this one phase. Withdrawals only drop standings, so a standing whose Runner holds no gate means the `raceId` was reused for another field: `advanceRace` refuses that state with an error naming the Runner instead of resuming it.

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
