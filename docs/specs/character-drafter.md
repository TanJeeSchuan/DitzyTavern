# Character Drafter

## Problem Statement

A Participant can be seeded from a Character, but nothing goes the other way. Someone who appears only in the prose, such as the bartender who matters by message 300, has no Definition, so the writer can't add them to the Cast, give them a Control seat, or reuse them in another Chat without writing their Definition by hand. A Cast member who has changed over a long story keeps the Definition they started with.

Boxes also can't read each other. Memory already knows who is in the story, what the story establishes about them and what they believe, but nothing outside Memory can ask.

## Solution

The Character Drafter is a built-in Box that writes a Definition Draft for one person. An agent reads the Chat's Selected narrative path by writing JavaScript in a sandbox. When Memory is enabled, the agent also reads Memory's Claims about the person through a Box Export, the first time one Box reads another. The agent submits a Definition whose example dialogue is lines quoted word for word from the Chat. The draft opens in the core Definition editor, where the writer adds it to the Cast, saves it as a Character, or replaces a Cast member's Definition with it.

See [ADR-0055](../adr/0055-let-boxes-answer-each-other-through-exports.md).

## User Stories

### Starting a draft

1. As a writer, I want a Character Drafter window that lists the people Memory knows about, so that I can pick someone from the story without typing their name.
2. As a writer, I want to type any name instead, so that I can draft someone Memory hasn't labeled, or draft in a Chat without Memory.
3. As a writer, I want an optional instruction field, such as "as she was before the war", so that I can steer which version of the person I get.
4. As a writer, I want "Draft from story" on a Cast member in the Participant editor, so that I can draft who they have become.
5. As a writer, I want the action disabled with a reason when no agent model is chosen, so that I know what to set up.

### While it runs

6. As a writer, I want to see what the agent is doing, one line per step, so that I know it's working.
7. As a writer who reads code, I want each step to expand to the code it ran and its output, so that I can check what it actually looked at.
8. As a writer, I want to cancel a draft, so that I can stop a run that's going the wrong way.

### What the draft holds

9. As a writer, I want facts the story establishes written as facts, so that the Definition matches the story.
10. As a writer, I want what other people say about the person kept apart and labeled as what they say, so that hearsay doesn't become fact.
11. As a writer, I want the person's own beliefs written as their point of view, so that the Definition sounds like them.
12. As a writer, I want example dialogue made only of lines the person actually says in the Chat, so that their voice isn't invented.
13. As a writer, I want the agent to use a fuller name it finds, so that "Bob" becomes "Bartholomew Crane" when the story says so.

### Using the draft

14. As a writer, I want the draft to open in the Definition editor, so that I can change anything before keeping it.
15. As a writer, I want "Add to Cast", so that the person joins this Chat.
16. As a writer, I want "Save as Character", so that I can reuse the person in other Chats.
17. As a writer who drafted a Cast member, I want "Replace *name*'s Definition", with a warning first, so that the Chat uses who they are now while keeping their Portrait and openings.
18. As a writer, I want closing the editor to discard the draft, so that drafts don't pile up.

## Implementation Decisions

1. **Box Exports.** A built-in Box's descriptor gains an optional `exports` map: `{ [name]: { description, input, output } }` with TypeBox schemas, and its server gains `exports: { [name]: (input, { database, conversationId }) => output }`, synchronous. The loader refuses a Box whose server and descriptor Exports differ. A sandboxed Box may not declare Exports.
2. **Reading Exports.** A Box's `routes(database, exportsOf)` receives `exportsOf(conversationId)`, which returns `{ [boxId]: { [name]: (input) => output } }` for every Box enabled in that Chat that declares Exports. It checks each input and output against the declared schemas and fails naming the Box, the Export and the path. The SDK exports no such function, so `advance`, digests and `fold` have no way to read Exports. A built-in Box types its Exports with `ExportsOf<typeof descriptor.exports>`, so each signature comes from the descriptor's schemas.
3. **Memory's Exports.** `people()` returns the person labels on the Selected narrative path after label merges. `selectedClaims()` returns every effective Claim on that path with its text, attribution, resolved people, evidence and source Message. The agent uses each Claim's text to determine the person's role in it.
4. **Code agent.** The server SDK gains `runCodeAgent({ boxId, instructions, globals, submitSchema, verify, signal, onActivity })`. It runs a libfx agent on the default delegate model, the one Connections sets as the Default delegate; no Box has a model of its own for it. So it needs a Chat Completions profile. It gives the agent two tools:
   - `run(code)` evaluates JavaScript in one QuickJS context that lasts for the whole run, holding `globals` frozen. 128 MiB heap per run, 2 s per call. It returns the logged output and the returned value as JSON, cut off at 8 KiB with a notice to narrow the query.
   - `submit(draft)` checks the draft against `submitSchema`, then calls `verify(draft)`. Either failure goes back to the model as a tool error. The first valid submit ends the run and is its result.
   - A run takes at most 24 steps, counting model requests and tool calls. The context is discarded when the run ends, fails or is cancelled.
   - `onActivity` receives each `run` as a one-line summary with its code and output.
   - Only built-in Boxes may call it. The agent's instructions include a short `.d.ts` of the globals.
5. **The Character Drafter Box.** `character-drafter`, `startsEnabled: true` and `prompt: false`. The Drafter has no Prompt Preset block and stays out of Generation capture and the preview fingerprint. Its route `POST /api/boxes/character-drafter/draft` takes `{ conversationId, person, instruction?, participantId? }` and streams activity, then the draft or the failure, over SSE. Closing the stream cancels the run. Nothing is stored. Both entry points require a successful read confirming that the Default delegate model is ready. When the model is unavailable or the check fails, they show why drafting cannot start.
6. **Sandbox globals.** Captured together, in one read transaction, when the run starts:
   - `messages`: the Selected narrative path as `{ id, index, author, authorParticipantId, text }`;
   - `cast`: `{ id, names }`;
   - `memory`: `{ people, claims: { [label]: Claim[] } }`, built from a single call to Memory's `selectedClaims()` through `exportsOf(conversationId)`. The Drafter groups Claims by resolved label and uses the Export's schema for the Claims. The value is null when Memory is off or fails to answer.

   The agent never calls an Export itself, so everything it reads answers for the same story.

   The agent's instructions say that `<thought>…</thought>` in the text marks unspoken thoughts.
7. **Submit and verify.** The draft is `{ name, prompt: { systemInstruction, identity, appearance, scenario, exampleDialogue, postHistoryInstruction }, quotes: [{ messageId, text }] }`. `verify` requires each quote to match a continuous span of spoken prose in a Message on the path. It uses the same thought parser as the Thoughts Box. Every nonblank line in `exampleDialogue` must come from a quote. Openings are empty. `verify` refuses Image References in Appearance.
8. **What goes where.** The instructions tell the agent to write facts the story establishes as facts, put what others say about the person in a labeled reputation paragraph in `identity`, write the person's beliefs as their point of view, and build `exampleDialogue` from quotes alone.
9. **Handing over.** The client SDK gains `openDefinitionDraft(draft, { conversationId, replaces?, onOpened })`, which opens the core `DefinitionEditor` prefilled. The workspace calls `onOpened` after navigation is approved. If the writer keeps editing, the Box keeps the draft available. The editor locks its fields during a save. Add to Cast sends `add-participant`. Save as Character creates a library Character. Replace, offered only with `replaces`, confirms first, then sends one `update-participant-definition` with the draft's name and Prompt and the Participant's Portrait and openings, which the editor shows from the start. The Box itself never writes to the Cast or the library.
10. **Entry points.** The Box's window holds the picker (labels from `exports.memory.people()` plus a name field), the instruction field, the activity feed and an open-draft button. Its `ParticipantSection` holds "Draft from story", which drafts that Participant with `participantId` set and opens the result with `replaces`.

## Testing

- Contract tests for `exportsOf`: a disabled or absent provider is missing; a provider output that fails its schema fails naming the Box, the Export and the path.
- Memory Export tests: label merges apply; a Writer override's Claims are the ones returned; Claims off the Selected narrative path aren't.
- `runCodeAgent` tests through the authoring fake: state persists between `run` calls; the heap and time limits fail the run with their reasons; output past 8 KiB is cut off; an invalid submit comes back as a tool error and a later valid one ends the run; the step cap fails the run; cancelling discards the context.
- `verify` tests: a quote that isn't a substring is refused; a quote inside a `<thought>` is refused; an `exampleDialogue` line that isn't a quote is refused.
- One e2e flow: draft a person from the window with Memory enabled, add them to the Cast, and see them in the Cast; draft a Cast member from the Participant editor, confirm Replace, and see the Portrait kept.

## Out of Scope

- Reading Exports from `advance`, digests or `fold`.
- Exports or agents for sandboxed Boxes.
- Communication between Box client UIs, so no entry point in Memory's inspector.
- A Message picker for an earlier version of someone: use a Fork or the instruction.
- Storing drafts, a link from a drafted Character back to its Chat, and keeping a Definition in step with the story.
- Semantic search and editable drafting instructions.
- Openings and Appearance Images in the draft.
