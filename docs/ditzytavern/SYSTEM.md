# DitzyTavern — System Definition

_**This file is the living source of truth for the architecture map.** The interactive atlas and the text twin are generated from the same data; edit this file, then rebuild both views._

_Question status: **5 open · 19 resolved**._

## One paragraph

DitzyTavern is a local, single-user, text-first cooperative writing workspace inspired by selected SillyTavern capabilities. The browser is a thin React SPA: it reads authoritative Conversation state, sends revisioned HTTP commands, and renders the active story. A deep Conversation module owns Cast, Control, Messages, Variants, authorship, SQLite transactions, and derived playability; a pure Prompt Compiler turns resolved Participants and selected history into a provider-neutral Prompt Plan. Native Chat creation and generation are composed through workflows, while the current SillyTavern import path stages exact uploaded bytes, lets the user resolve author groups, and graduates the result into an ordinary Conversation. The OpenAI-style Model Client and resumable SSE edge are settled architectural seams but are not yet switched on in the current source tree.

## Decisions locked

| Axis | Decision | ADR |
|---|---|---|
| Product boundary | Clean-slate focused reimplementation; local, single-user, text-first, with one active human and model Control seat. | [0001](../adr/0001-focused-reimplementation.md) |
| Authority | The server owns Conversation state, prompt assembly, generation lifecycles, persistence, and coordination. | [0002](../adr/0002-server-authoritative-runtime.md) |
| Commands and events | Use revisioned HTTP commands plus resumable SSE; replay is bounded and snapshot fallback is authoritative. | [0004](../adr/0004-use-http-commands-and-resumable-sse.md) |
| Runtime | Use TypeScript and Elysia for the typed HTTP surface. | [0011](../adr/0011-use-typescript-and-elysia.md) |
| Browser | Serve a static React SPA; the browser owns presentation state, not domain authority. | [0012](../adr/0012-serve-a-client-rendered-static-spa.md) |
| Conversation seam | Keep a small deep Conversation interface over snapshots, commands, history, and generation commits. | [0013](../adr/0013-center-the-server-on-a-deep-conversation-module.md) |
| Prompting | Compile a deterministic provider-neutral Prompt Plan in a pure module. | [0014](../adr/0014-isolate-a-pure-prompt-compiler.md) |
| Model edge | Hide OpenAI-style streaming translation, credentials, cancellation, and errors behind one Model Client. | [0015](../adr/0015-hide-model-transport-in-one-deep-module.md) |
| Identity | Character, Conversation-local Participant, Control seat, and immutable Message authorship are separate concepts. | [0016](../adr/0016-separate-characters-participants-and-authorship.md) |
| Reusable identities | Character Library owns complete Definitions and revisioned lifecycle; adding a Character forks its Definition into the Cast. | [0017](../adr/0017-isolate-the-character-library.md) |
| Variants | Alternative model replies are sibling Variants at one Message position; selection is revisioned and non-destructive. | [0003](../adr/0003-model-alternative-replies-as-variants.md) |
| Persistence | Drizzle is the typed query layer over bun:sqlite; domain modules still own their tables and invariants. | [0024](../adr/0024-adopt-drizzle-orm-and-drizzle-kit.md) |
| Settings | Global connection settings are separate from Conversation-owned generation settings and are applied atomically. | [0019](../adr/0019-split-connection-and-generation-settings.md), [0023](../adr/0023-apply-configuration-edits-atomically.md) |
| Secrets | Credentials stay in server-owned application configuration and never enter SQLite, snapshots, prompts, events, or logs. | [0022](../adr/0022-keep-connection-secrets-outside-conversation-state.md) |

## Cost model

No external service cost is modeled: version one is local and text-only.
The remote model endpoint is user-configured; credentials remain server-owned application configuration and never enter Conversation state.
## Reading order (the atlas chapters)

1. **You and the writing surface** — Start with the only thing a user needs to feel: the story surface answers to explicit intent. _(adds UI, API)_
2. **The Conversation center** — One deep module owns the Chat shape that every surface depends on. _(adds CONV)_
3. **Durable local state** — The center is durable because SQLite is authoritative, local, and transaction-backed. _(adds DB)_
4. **Assembling the next turn** — Before any provider sees a request, the server builds a named, inspectable Prompt Plan. _(adds PROMPT)_
5. **Composing generation** — Workflows compose the deep seams today; the concrete Model Client is the next edge to switch on. _(adds WF, TRANSPORT)_
6. **Reading and swiping** — The story stays light to read while Variants remain explicit, selectable, and non-destructive. _(adds HISTORY)_
7. **Characters become Participants** — Reusable Characters seed independent Conversation-local identities; they never become hidden live links. _(adds CHAR)_
8. **Keeping imports honest** — Imports preserve custody first, then ask the user to resolve identity before they become playable. _(adds IMPORT, ART)_
9. **Edges we have deliberately deferred** — Several future capabilities have named seams, but none should blur the current product boundary. _(adds SSE, LORE, EXT)_
10. **The whole DitzyTavern system** — Everything at once, for tracing one reply, creating a Chat, reading history, or graduating an import.

## Structures

### The main loop

#### UI · React writing workspace

**In one line.** The browser renders the active Chat and collects explicit user intent.

**What it does.** DitzyTavern opens on the active Conversation. The story surface, Cast controls, composer, Swipe actions, import panels, and settings are presentation over server-owned state.

**How it's built.** The static React/Vite client is rooted at `src/client/App.tsx`. `ActiveWritingWorkspace` loads snapshots and paged history, keeps drafts locally, and applies authoritative results after typed API outcomes.

**Steps in execution.**

1. **Open** — Load the workspace and active Chat.
2. **Read** — Fetch the latest history page and preserve scroll anchoring.
3. **Act** — Send a revisioned command or start a staged flow.
4. **Render** — Apply the returned Conversation summary without inventing domain state.

**Questions.**

- **Q-UI1** How will the current SPA receive live token and lifecycle events when the planned event edge is implemented? → _SSE route implementation_
- **Q-UI2** Which prompt-inspection editing affordances belong in the right-side details surface? → _Prompt inspection UX pass_

#### API · Typed Elysia contract

**In one line.** Thin routes translate HTTP into public domain seams and typed outcomes.

**What it does.** The API gives the browser stable reads, revisioned commands, history pages, native Chat creation, Character Library operations, and staged import endpoints. It should not coordinate tables or duplicate rules.

**How it's built.** `src/shared/contract.ts` composes typed Elysia route modules. Conversation routes call `createConversationModule`; import routes preserve the raw request stream for staging; conflict and not-playable results are mapped to explicit transport outcomes.

**Steps in execution.**

1. **Decode** — Validate path, query, and body shapes at the boundary.
2. **Delegate** — Call one deep module or a named workflow.
3. **Map** — Turn typed errors into 404, 409, or 422 outcomes.
4. **Return** — Send an authoritative summary or staged preview.

**Questions.**

- ~~**Q-API1** Should client-facing error reasons become stable machine codes before the API is expanded?~~ ✓ Current routes expose typed outcome discriminants plus contextual reason strings; revisit when a second external client exists (2026-08-24).

#### CV · Conversation module

**In one line.** The deep seam that owns Cast, Control, history, Messages, Variants, and Conversation invariants.

**What it does.** Conversation is the center of the server. It exposes a deliberately small interface while hiding revisions, Participants, active Control seats, immutable Author Stamps, selected Variants, data scopes, transactions, and derived playability.

**How it's built.** `src/server/conversation/index.ts` exposes snapshot reads, paged history, revisioned command execution, and server-side generation commits. The implementation spans `create.ts`, `execute.ts`, `snapshot.ts`, `history.ts`, and command modules.

**Steps in execution.**

1. **Capture** — Read one authoritative snapshot and its current revision.
2. **Validate** — Check Control, Participant, Message, Variant, and stale-revision rules.
3. **Mutate** — Apply one command in a SQLite transaction.
4. **Publish** — Return the updated snapshot or a typed conflict.

**Questions.**

- **Q-CV1** Where should active Generation lifecycle coordination sit once streaming transport is real? → _Generation lifecycle deep dive_
- ~~**Q-CV2** Should one Conversation module continue to own both history paging and generation coordination as concurrency grows?~~ ✓ Keep the public seam small and unified; split internal table/domain work only when a demonstrated pressure point appears (2026-08-24).

#### PC · Prompt Compiler

**In one line.** A pure compiler turns resolved identities and selected history into a provider-neutral Prompt Plan.

**What it does.** Prompt assembly is deterministic and inspectable. It knows named block order, Participant role mapping, Example Dialogue, selected history, macros, warnings, and local budget behavior without knowing SQLite, HTTP, credentials, or a model vendor.

**How it's built.** `src/server/prompt-compiler/compiler.ts` implements `compilePrompt`, `compileOpening`, and one-pass `{{self}}`/`{{other}}` expansion. The result is consumed by workflows and can be shown through prompt inspection.

**Steps in execution.**

1. **Resolve** — Use the current human/model Participants and selected history.
2. **Order** — Emit system instruction, identities, scenario, examples, history, and post-history instruction.
3. **Budget** — Reserve response budget and trim lower-priority context when configured.
4. **Inspect** — Return named blocks, warnings, estimates, and omitted context.

**Questions.**

- **Q-PC1** What evidence should eventually replace the bundled tokenizer estimate for arbitrary model identifiers?
- **Q-PC2** When should a provider-neutral Prompt Plan become a persisted audit record? → _Prompt inspection UX pass_

#### MC · Model Client _(not switched on)_

**In one line.** Planned boundary for translating a Prompt Plan into one OpenAI-style streaming request.

**What it does.** The ADR is settled, but the current tree injects a `generate(plan)` function into workflows instead of shipping a concrete transport module. The future seam will own credentials, request translation, streaming parsing, cancellation, timeout, normalized events, and provider errors.

**How it's built.** Designed in ADR-0015; no `src/server/model-client/` implementation is currently present. It must accept a provider-neutral Plan, force one Variant, preserve reasoning separately, and never retry an ambiguous request automatically.

**Steps in execution.**

1. **Translate** — Map named Prompt Plan blocks to the configured protocol.
2. **Stream** — Normalize visible content, reasoning, usage, finish, and keepalive events.
3. **Cancel** — Stop only the targeted Generation on user or timeout cancellation.
4. **Report** — Return normalized terminal outcome and optional usage.

**Questions.**

- **Q-MC1** Which concrete OpenAI-style streaming adapter should be implemented first?
- **Q-MC2** Where should connection configuration live while remaining outside Conversations? → _Connection settings implementation_

### Authoritative state

#### DB · SQLite and Drizzle state

**In one line.** The local database stores authoritative entities, revisions, history, copied Definitions, and metadata.

**What it does.** SQLite is the durable source of truth for Chats, Messages, Variants, Participants, Control assignments, Characters, generic data scopes, and artifact metadata. A small Database module opens it, applies migrations, and configures WAL/foreign keys.

**How it's built.** `src/server/database/database.ts` opens `bun:sqlite` and runs Drizzle migrations. `src/server/database/schema.ts` defines the tables; domain modules use Drizzle directly instead of a generic repository layer.

**Steps in execution.**

1. **Open** — Create the local file or in-memory test database.
2. **Prepare** — Enable foreign keys, WAL, busy timeout, and migrations.
3. **Transact** — Let the owning module commit a complete domain mutation.
4. **Read** — Build snapshots and paged history from current rows.

**Questions.**

- **Q-DB1** Do Connection Settings and Generation Settings need dedicated tables beyond current domain data scopes? → _Connection settings implementation_
- ~~**Q-DB2** How should cleanup of committed artifact files be reconciled with database deletion?~~ ✓ Database deletion removes metadata only; physical copies remain for manual recovery and are not automatically garbage-collected (2026-08-24).

#### HI · History read seam

**In one line.** Paged history keeps ordinary story reading light while preserving stable chronology.

**What it does.** The active story loads the newest window first and asks for older pages on demand. Variant bodies and immutable author identity are enough for reading; heavy provenance stays behind deliberate detail surfaces.

**How it's built.** `ConversationModule.readHistory` delegates to `src/server/conversation/history.ts`. The React workspace prepends older pages with scroll anchoring, and selection remains a revisioned Conversation command.

**Steps in execution.**

1. **Page** — Request a bounded page counted backward from the newest Message.
2. **Project** — Return active Cast identity and lightweight Variants.
3. **Prepend** — Add older Messages without moving the reading viewport.
4. **Select** — Persist Swipe selection through the Conversation revision.

**Questions.**

- ~~**Q-HI1** Should heavy provenance and prompt details remain separate from the normal history payload?~~ ✓ Yes. Ordinary reads stay lightweight; deliberate detail operations load exact artifacts, reasoning, signatures, or prompt inspection only when requested (2026-08-24).

### Supporting seams

#### CH · Character Library

**In one line.** Reusable Characters own complete Definitions that can seed independent Cast Participants.

**What it does.** The library is optional convenience, not the identity model. It lists, reads, edits, pins, and deletes reusable Definitions with revisions. Adding one to a Chat copies its name, prompt, and openings into a new Conversation-local Participant.

**How it's built.** `src/server/character-library/` exposes a small revisioned module. Character edits never synchronize into existing Participants; referenced deletion creates a hidden tombstone so provenance remains meaningful.

**Steps in execution.**

1. **List** — Order active Characters by pin, name, and stable identifier.
2. **Edit** — Replace the complete prompt or ordered openings under expected revision.
3. **Fork** — Copy a Definition into a new Cast Participant.
4. **Retain** — Keep provenance even when the source Character is later tombstoned.

**Questions.**

- **Q-CH1** When should duplicate Character names require a stronger user-facing disambiguator than computed ordinal labels?
- ~~**Q-CH2** Should Character provenance ever become an identity or synchronization key?~~ ✓ No. Provenance is informational; selecting a Cast identity and adding from the Library remain distinct operations (2026-08-24).

#### WF · Composition workflows

**In one line.** Workflows compose deep seams for native Chat creation, generation, and Character-to-Cast actions.

**What it does.** Workflows own cross-module use cases without becoming alternate domain stores. They resolve Character revisions, build Conversation creation input, derive Prompt Plans, inject transport behavior, and commit completed Messages or sibling Variants.

**How it's built.** `src/server/workflows/` contains `native-chat.ts`, `generate.ts`, `add-character-to-cast.ts`, and save-back workflows. The public routes call these compositions, while tests can inject deterministic generation functions.

**Steps in execution.**

1. **Compose** — Resolve each use case across its public module interfaces.
2. **Capture** — Snapshot active Control, author name, and historical context at generation start.
3. **Delegate** — Call the pure compiler or injected model function.
4. **Commit** — Return to Conversation for one authoritative persistence mutation.

**Questions.**

- **Q-WF1** Should workflow APIs expose a first-class Generation object once streaming exists? → _Generation lifecycle deep dive_
- ~~**Q-WF2** Where should prompt edits for one Generation be validated?~~ ✓ Keep the one-shot edited Prompt Plan inside the Generation workflow; do not mutate Participant Prompts or Conversation history (2026-08-24).

#### IM · Staged Chat import

**In one line.** A preservation-first flow validates, resolves, reviews, and graduates an export into a normal Chat.

**What it does.** The import path never fabricates identity silently and never commits a partial interpretation. It streams the uploaded JSONL once, binds a session token to exact bytes, groups source authors without merging them, proposes name-only Character matches, and waits for explicit user resolution.

**How it's built.** `src/server/sillytavern/staged.ts` owns the staged registry and commit boundary; `staged/preview.ts` builds the preview. The commit uses public Character and Conversation seams, preserves every Message and Variant, and stores a canonical report plus exact source artifact.

**Steps in execution.**

1. **Stage** — Stream bytes to temporary storage while hashing them.
2. **Inspect** — Validate JSONL and report counts, warnings, author groups, and duplicate evidence.
3. **Resolve** — Let the user split, merge, rename, fork, or keep Chat-only Participants.
4. **Graduate** — Atomically create a normal Conversation with preserved history and custody metadata.

**Questions.**

- ~~**Q-IM1** How should a one-author or zero-author import surface its missing Control seat?~~ ✓ Commit as an incomplete native Conversation, keep history readable and editable, and withhold Compose, Generate, and Swipe until a second distinct Participant is added (2026-08-24).
- ~~**Q-IM2** Should related-source matches block import the way exact raw-byte duplicates do?~~ ✓ No. Exact SHA-256 matches require explicit Import another copy confirmation; declared-integrity-only related matches remain advisory (2026-08-24).

#### AR · Exact artifact custody

**In one line.** Managed files preserve original bytes beside verifiable metadata without making files the domain authority.

**What it does.** Imports keep an exact source copy under a managed relative path. SQLite stores filename, media type, byte length, and SHA-256; reads and downloads verify those values and report missing or corrupt files as cleaned-up provenance rather than corrupting the Chat.

**How it's built.** `src/server/artifact/` owns metadata lookup, byte verification, download disposition, and managed paths. The Conversation creation seam inserts artifact metadata atomically; physical copies are deliberately not deleted by Chat deletion.

**Steps in execution.**

1. **Finalize** — Move the verified staged file to a unique managed path.
2. **Record** — Commit metadata with the Conversation and import report.
3. **Verify** — Compare stored bytes to recorded length and SHA-256 on inspection.
4. **Download** — Return exact bytes with a sanitized presentation filename.

**Questions.**

- ~~**Q-AR1** When should orphaned managed files be reclaimed?~~ ✓ Not automatically in version one; leaving exact copies recoverable is preferred over a risky cleanup job (2026-08-24).

### Designed for, not switched on (designed for, not built)

#### EV · Resumable live events _(not switched on)_

**In one line.** Planned event edge for streaming Generation output and synchronizing multiple views.

**What it does.** The architecture reserves resumable Server-Sent Events for ordered Conversation and Generation updates. The current server has the HTTP and SPA pieces but no `/events` implementation, so this remains visibly deferred.

**How it's built.** ADR-0004 specifies ordered event IDs, bounded replay, last-event resumption, and fresh snapshot fallback after a miss or restart. The event buffer is not a permanent domain-event log.

**Steps in execution.**

1. **Subscribe** — Open a Conversation-scoped event stream.
2. **Replay** — Use the last received event ID when the bounded buffer can satisfy it.
3. **Fallback** — Return a fresh authoritative snapshot when replay is unavailable.
4. **Stream** — Deliver lifecycle and token updates without advancing revision for transient text.

**Questions.**

- ~~**Q-EV1** Should the replay buffer remain process-local or move to a shared deployment store?~~ ✓ Keep it bounded and non-authoritative; snapshot fallback after restart avoids introducing a durable event log in version one (2026-08-24).

#### WI · World Info blocks _(not switched on)_

**In one line.** Deferred named-block context for lorebook and World Info behavior.

**What it does.** Version one intentionally compiles only active Participant prompt channels, Example Dialogue, and selected Conversation history. A future named-block prompt system may add World Info without smuggling a lorebook scanner into the current loop.

**How it's built.** ADR-0001 explicitly excludes World Info and lorebook scanning. The future seam must feed the Prompt Compiler rather than bypassing it.

**Steps in execution.**

1. **Define** — Specify named blocks and their precedence.
2. **Select** — Determine which entries apply to a Conversation turn.
3. **Compile** — Hand resolved content to the Prompt Compiler.

**Questions.**

- **Q-WI1** What named-block API and selection trigger should future World Info use?

#### EX · Extension runtime _(not switched on)_

**In one line.** A future extension surface is deliberately absent until a demonstrated use case earns it.

**What it does.** DitzyTavern is not preserving SillyTavern plugin compatibility. Version one supports explicit core Conversation commands and keeps the main loop understandable.

**How it's built.** ADR-0001 excludes a user-installable extension or plugin runtime. Any future capability must earn a seam from concrete use rather than a generic hook lattice.

**Steps in execution.**

1. **Observe** — Identify a repeated need in the supported flow.
2. **Constrain** — Define a narrow capability and trust boundary.
3. **Expose** — Add one explicit seam with tests and ownership.

**Questions.**

- ~~**Q-EX1** What real use case would justify an extension runtime?~~ ✓ No runtime in version one; revisit only from demonstrated product use, not compatibility pressure (2026-08-24).

#### MD · Media and tool pipeline _(not switched on)_

**In one line.** Attachments, multimodal input, image generation, speech, and model tools are separate future pipelines.

**What it does.** Version one is text-only. Adding media or tools would change storage, provider translation, prompt representation, rendering, and security boundaries, so they remain a ghost rather than an implied feature of the current Model Client.

**How it's built.** ADR-0001 excludes attachments, multimodal Messages, image generation, speech input/output, and model tool calls. Each future capability should first establish its own artifact, transport, and UI contracts.

**Steps in execution.**

1. **Model** — Define the new content and security contract.
2. **Store** — Choose custody and lifecycle for non-text data.
3. **Translate** — Add provider-neutral representation before vendor mapping.

**Questions.**

- **Q-MD1** Which media or tool use case is concrete enough to split into a separate pipeline?

#### DR · Durable import drafts _(not switched on)_

**In one line.** A durable resume system for staged imports is intentionally not part of version one.

**What it does.** Staged handles are process-local and session-bound. A server restart expires the flow and asks the user to select the file again; committed files are not removed by that expiry.

**How it's built.** `staged.ts` keeps handles in an in-memory registry and retains consumed results for idempotent retries. No durable import draft table or cleanup journal exists.

**Steps in execution.**

1. **Hold** — Keep one uploaded source and preview in temporary storage.
2. **Expire** — Let restart or discard remove the active handle.
3. **Retry** — Require file reselection after process loss.

**Questions.**

- ~~**Q-DR1** When does import volume or interrupted review make durable drafts worth the complexity?~~ ✓ Not yet; session-bound staging keeps the preservation path narrow and recoverable (2026-08-24).

## Flows (representative packets)

Payload shapes are what the design implies, not measured traffic.

### Native reply

| # | From → To | Packet | Representative payload |
|---|---|---|---|
| 1 | UI → API | send command | `{"expectedRevision":7,"action":"create-message"}` |
| 2 | API → CONV | revisioned command | `{"action":"create-message","revision":7}` |
| 3 | CONV → PROMPT | selected history | `{"human":"Writer","model":"Character","messages":12}` |
| 4 | PROMPT → TRANSPORT | Prompt Plan | `{"blocks":8,"budget":"estimated"}` |
| 5 | TRANSPORT → CONV | normalized completion | `{"contentDelta":"The room went quiet…","finish":"stop"}` |
| 6 | CONV → DB | atomic commit | `{"message":14,"variants":1,"revision":8}` |
| 7 | DB → UI | authoritative update | `{"selectedVariant":31,"status":"applied"}` |

### Create a Chat

| # | From → To | Packet | Representative payload |
|---|---|---|---|
| 1 | UI → API | new Chat request | `{"name":"A quiet morning"}` |
| 2 | API → WF | native workflow | `{"humanSeat":"adhoc","modelSeat":"character#4"}` |
| 3 | WF → CHAR | read Character | `{"characterId":4,"expectedRevision":2}` |
| 4 | WF → CONV | complete creation input | `{"participants":2,"control":["human","model"]}` |
| 5 | CONV → DB | create transaction | `{"chat":9,"roster":2,"openings":1}` |
| 6 | DB → UI | new active Chat | `{"conversationId":9,"playable":true}` |

### Read older history

| # | From → To | Packet | Representative payload |
|---|---|---|---|
| 1 | UI → API | older page | `{"conversationId":9,"page":2,"pageSize":20}` |
| 2 | API → HISTORY | history read | `{"page":2,"pageSize":20}` |
| 3 | HISTORY → DB | position window | `{"from":1,"to":20,"order":"chronological"}` |
| 4 | DB → HISTORY | lightweight Messages | `{"messages":20,"variants":"selected + siblings"}` |
| 5 | HISTORY → UI | prepend and anchor | `{"hasOlder":false,"scroll":"stable"}` |

### Graduate an import

| # | From → To | Packet | Representative payload |
|---|---|---|---|
| 1 | UI → API | stream upload | `{"filename":"chat.jsonl","bytes":"ReadableStream"}` |
| 2 | API → IMPORT | stage and hash | `{"sha256":"raw-byte digest","token":"session-bound"}` |
| 3 | IMPORT → ART | finalize exact source | `{"mediaType":"application/jsonl","verified":true}` |
| 4 | IMPORT → CHAR | name-only suggestion | `{"key":"Mira","match":"case-insensitive","confirmed":false}` |
| 5 | IMPORT → CONV | atomic graduation | `{"messages":42,"participants":3,"playability":"derived"}` |
| 6 | CONV → DB | history + report + metadata | `{"archive":"canonical","source":"exact copy"}` |
| 7 | DB → UI | ordinary Chat receipt | `{"conversationId":12,"opensImmediately":true}` |

## Questions — index

Reference by ID. ✓ resolved (with date) · otherwise open.

- **Q-UI1** (UI) How will the current SPA receive live token and lifecycle events when the planned event edge is implemented?
- **Q-UI2** (UI) Which prompt-inspection editing affordances belong in the right-side details surface?
- ~~**Q-API1**~~ (API) ✓ Current routes expose typed outcome discriminants plus contextual reason strings; revisit when a second external client exists (2026-08-24).
- **Q-CV1** (CV) Where should active Generation lifecycle coordination sit once streaming transport is real?
- ~~**Q-CV2**~~ (CV) ✓ Keep the public seam small and unified; split internal table/domain work only when a demonstrated pressure point appears (2026-08-24).
- **Q-PC1** (PC) What evidence should eventually replace the bundled tokenizer estimate for arbitrary model identifiers?
- **Q-PC2** (PC) When should a provider-neutral Prompt Plan become a persisted audit record?
- **Q-MC1** (MC) Which concrete OpenAI-style streaming adapter should be implemented first?
- **Q-MC2** (MC) Where should connection configuration live while remaining outside Conversations?
- **Q-DB1** (DB) Do Connection Settings and Generation Settings need dedicated tables beyond current domain data scopes?
- ~~**Q-DB2**~~ (DB) ✓ Database deletion removes metadata only; physical copies remain for manual recovery and are not automatically garbage-collected (2026-08-24).
- ~~**Q-HI1**~~ (HI) ✓ Yes. Ordinary reads stay lightweight; deliberate detail operations load exact artifacts, reasoning, signatures, or prompt inspection only when requested (2026-08-24).
- **Q-CH1** (CH) When should duplicate Character names require a stronger user-facing disambiguator than computed ordinal labels?
- ~~**Q-CH2**~~ (CH) ✓ No. Provenance is informational; selecting a Cast identity and adding from the Library remain distinct operations (2026-08-24).
- **Q-WF1** (WF) Should workflow APIs expose a first-class Generation object once streaming exists?
- ~~**Q-WF2**~~ (WF) ✓ Keep the one-shot edited Prompt Plan inside the Generation workflow; do not mutate Participant Prompts or Conversation history (2026-08-24).
- ~~**Q-IM1**~~ (IM) ✓ Commit as an incomplete native Conversation, keep history readable and editable, and withhold Compose, Generate, and Swipe until a second distinct Participant is added (2026-08-24).
- ~~**Q-IM2**~~ (IM) ✓ No. Exact SHA-256 matches require explicit Import another copy confirmation; declared-integrity-only related matches remain advisory (2026-08-24).
- ~~**Q-AR1**~~ (AR) ✓ Not automatically in version one; leaving exact copies recoverable is preferred over a risky cleanup job (2026-08-24).
- ~~**Q-EV1**~~ (EV) ✓ Keep it bounded and non-authoritative; snapshot fallback after restart avoids introducing a durable event log in version one (2026-08-24).
- **Q-WI1** (WI) What named-block API and selection trigger should future World Info use?
- ~~**Q-EX1**~~ (EX) ✓ No runtime in version one; revisit only from demonstrated product use, not compatibility pressure (2026-08-24).
- **Q-MD1** (MD) Which media or tool use case is concrete enough to split into a separate pipeline?
- ~~**Q-DR1**~~ (DR) ✓ Not yet; session-bound staging keeps the preservation path narrow and recoverable (2026-08-24).

## What the platform gives vs what we own

**Platform gives:** Bun, bun:sqlite, Drizzle ORM, Elysia, React, TypeScript, Vite, and the browser provide runtime, transport, rendering, and migration primitives.

**We own:** Conversation invariants, Character forks, prompt compilation, revision/conflict behavior, import preservation, artifact custody, generation coordination, and the user-facing resolution flow.

## Planned filesystem

```
src/server/conversation/      deep Conversation seam
src/server/character-library/ reusable Definitions
src/server/workflows/         native Chat, generation, and Character composition
src/server/prompt-compiler/   pure provider-neutral Prompt Plan
src/server/sillytavern/       adapter, staging, preview, and atomic graduation
src/server/artifact/          exact-file metadata and verified reads
src/server/database/          SQLite, Drizzle schema, migrations
src/shared/contract/          typed Elysia HTTP adapters
src/client/                   React SPA and story workspace
docs/adr/                     architectural decisions
docs/ditzytavern/atlas/       this source plus generated views
```

## How this file is maintained

Generated from `docs/ditzytavern/atlas/data.mjs` by `node docs/ditzytavern/atlas/build.mjs`, which also builds the interactive atlas (`atlas.html`). Edit the data file, rebuild, republish — never edit this file by hand.
