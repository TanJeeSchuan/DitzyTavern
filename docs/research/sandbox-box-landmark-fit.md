# Sandbox Box: Race and Memory fit

Research against commit `609df8eda09a3ecedf575e0f48d46a9c900e82c9`, 2026-11-03. Source code was read only. No runtime benchmark, full tests, typecheck or e2e was run. References below are relative to this document; line numbers refer to this checkout. “Verified” means read in source; proposed signatures and performance estimates are design inferences.

## Verdict

Race ports cleanly at the simulation layer. Its complete product needs scoped Library/Character/Participant storage, atomic setup saves, image handling and a window bridge. The existing `read` response alone does not supply everything its client uses.

Memory can port without SQL or arbitrary routes. It requires snapshot reads, guarded commits, model grants, asynchronous model calls with cancellation, digest controls, record overrides and four UI slots. These are missing capabilities, not reasons to give it the database. The current Memory implementation cannot cross a JSON boundary unchanged.

Reject raw database handles, caller-chosen Box identities, unrestricted connection configuration, arbitrary HTTP handlers, host imports and host React execution. Preserve their legitimate operations through narrower interfaces. Race also needs access beyond Chat storage: its own Library avatars and source Character stats.

Use normal QuickJS with Promise-returning host functions unless a measured requirement demands asyncify. Asyncify is **not required** for asynchronous `llm`, `decide` or `embed`. Memory's synchronous capture and read operations must remain synchronous against one snapshot; merely making every hook async breaks the current host.

A single registered `sandbox` Box is not automatically equivalent to several generated Boxes. Independent lifecycle instances, seeds, preset blocks, Decision selections, traces and schema checking still need child identity in trusted host code. This is a larger integration requirement than the VM wrapper.

### Minimal proposed capability set

These signatures describe a narrow protocol, not existing exports. `J` means validated JSON. All capabilities bind the generated Box identity and version, its current instance, and (where applicable) its Chat on the host. No call accepts a namespace, Box id, SQL, endpoint or credentials. `Revision`, `Snapshot`, model handles and cancellation-group handles are host-issued tokens. A Library settings surface has Library authority, not a guessed Chat id. Request/result size and call-count limits apply on the host.

| Capability and signature | Needed by | Contract |
|---|---|---|
| `snapshot(query: ReadQuery): { token: Snapshot, data: J }` | Both | Synchronous reads during capture/read; one database snapshot. Query variants: own values by key/prefix and allowed owner; source-Character value revisions; own record slots for permitted Variant ids; Chat summary projection, variants including alternatives, authors, removed Participants, active Variant ids, source existence, own lifecycle and digest progress. Seed/intent/selected history arrive as hook inputs. |
| `commit({ snapshot, expected, writes, setup? }): AppliedOrConflict` | Both | Atomic bounded batch; own Chat/Library values, allowed Participant values, and source Character values. Recheck Chat/lifecycle/value/Character revisions and membership predicates used by the command. Setup and all Race stat writes land together. No guest transaction callback. Conflicts return a projection of authoritative values. |
| `models(): { completion, embedding, decision }` | Memory | Only granted selections: opaque handle, availability, display label/model, token limit, deadline and stable configuration fingerprint. Bind the selection for a capture/job; do not enumerate application configuration. |
| `complete(handle, { prompt, contextLimit, responseBudget, deadlineMs, maxOutputBytes, group? }): Promise<{ content, finishReason }>` | Memory | Enforce 64 KiB extraction output while streaming, not after buffering; preserve `stop/length/other`. Host validates requested limits against grant limits. |
| `decide(state: J, questions: J): Promise<[string, DecisionAnswer][]>` | Memory | Own captured Decision selection, same request packing/token estimator. Return entries instead of a host Map. |
| `embed(handle, texts: string[], { cache, group? }): Promise<number[][]>` | Memory | Functional minimum; same vector ordering, dimensions, Float32 rounding and cache identity. See performance section before adopting large JSON vector responses. |
| `cancelGroup(): Group; cancel(group: Group): void; throwIfAborted(): void` | Memory | VM-local group mapped to host cancellation; all requests inherit job cancellation. Preserve sibling cancellation when one embedding request fails. Reject late results after cancellation/disposal. |
| `recordCommand({ kind: "set", messageId, variantId, expectedRevision, expectedRecord, record } | { kind: "reset", messageId, variantId, expectedRevision }): Outcome` | Memory | Host ownership/schema checks; writer overlays automatic. Expected record is needed because background digest changes need not advance the Chat revision. |
| `digestCommand({ kind: "passage", variantId } | { kind: "startCatchUp" } | { kind: "cancelCatchUp" }): Outcome` | Memory | Existing queue, enabled gate, current instance, cancellation and progress notifications. |
| `read({ surface, query? }): Promise<Projection>; command({ name, input: J }): Promise<Outcome>` | Both | Iframe calls only the trusted bridge. Guest server projection owns all exposed story data, including trace rendering input. Nine Memory routes become four read queries and five named commands; no route registration. |
| `stageMoves(moves: J[]): Outcome` | Race | Replace only this Box's composer Moves; enforce max/schema/enabled/seat rules. Staging is not sending a Message or advancing the simulation. |
| `uploadImage(blob: Blob): Promise<ImageRef>` | Race | Browser bridge transfer, bounded and validated by host; return an image grant/hash plus display URL. Blob is a structured-clone transfer, not the logic VM's JSON protocol. |
| `displayImage(ref: ImageRef): { url, focalX, focalY }` | Both | Scoped image display for Race avatars and Cast Portraits; no arbitrary URL-fetch capability. Can be supplied directly in projection instead of a separate call. |
| `ui(event: NavigateSource | OpenOwnSettings | OpenConnections | Close | DirtyState): void` | Both | Whitelisted host navigation/save-guard notifications. Source ids must belong to the bound Chat. DirtyState supports host save/discard requests with request ids. |
| `chooseModel(role: "completion" | "embedding"): Promise<ModelGrant>` | Memory | Trusted host picker; guest receives only the selected grant and display metadata. Selection persistence must use revision checks. |

ReadQuery is a closed discriminated union, not a generic object/property accessor. Snapshot tokens cannot address arbitrary Chats. For write commands whose validation reads Cast membership or existence, `expected` must cover those reads too; guarding only the value being written is insufficient.

UI slots are `Window.Panel` + `Status` for Race, and `Inspector` + `Settings` + `ParticipantSection` + `TraceView` for Memory. A status string can remain host-rendered. The other slots can contain frames; shell controls stay trusted.

Pure support code is not authority: include compatible schema validation, JSON structural equality, image-anchor projection, token estimation/slicing, decision request packing, effective-record/status helpers and cosine math in the guest library. `sha256(text): string` may be a bounded synchronous host primitive or bundled pure JS; the present implementation imports Node crypto. Retain exact hashing, token estimates and ordering if identical Prompt Plans are the acceptance criterion.

## Race dependency inventory

Classes: **a** fits JSON/pure execution; **b** requires the named capability/slot; **c** reject the present privileged interface. A c row can have a safe b replacement; it does not mean refusing the feature.

| Dependency | Source | Class | Sandbox answer |
|---|---|---|---|
| Initial state, fold, seeded simulation and full post-Stretch records | [server.ts:11](../../src/boxes/race/server.ts#L11), [server-engine.ts:6](../../src/boxes/race/server-engine.ts#L6), [shared-data.ts:42](../../src/boxes/race/shared-data.ts#L42) | a | Plain JSON; preserve `raceId` filtering and deterministic seed. Engine uses local modules and the pure `isNonEmpty` SDK helper. |
| Move rendering and legality shared with UI | [server.ts:12](../../src/boxes/race/server.ts#L12), [shared.ts:43](../../src/boxes/race/shared.ts#L43) | a | Same text/order/rules. No model/DB service needed. |
| Captured seed, intent, Cast membership/withdrawals | [server.ts:16](../../src/boxes/race/server.ts#L16) | b | Preserve synchronous `dependencies(capture, setup)` hook. Project only required capture fields; default fingerprint includes these dependencies. |
| Setup validation using `node:util.isDeepStrictEqual` | [server.ts:1](../../src/boxes/race/server.ts#L1), [server.ts:46](../../src/boxes/race/server.ts#L46) | c | Refuse Node imports. Replace with JSON structural equality, preserving key-order independence; naive stringify equality is not equivalent. Validation itself is pure. |
| Own Participant stats, Library avatar prefix scan, source Character revisions | [server.ts:32](../../src/boxes/race/server.ts#L32), [server-cast.ts:12](../../src/boxes/race/server-cast.ts#L12) | b | `snapshot` with those three queries, inside the window read snapshot. Decode stats against schema; malformed stored stats remain errors. |
| Raw Drizzle handle and caller-supplied `race` id | [server-cast.ts:13](../../src/boxes/race/server-cast.ts#L13), [server.ts:40](../../src/boxes/race/server.ts#L40) | c | Guest gets neither handle nor identity argument. |
| Hidden intents and replay projection | [server.ts:29](../../src/boxes/race/server.ts#L29) | a | `spectatorOf` removes both from phase state; separate replay payload releases them only when finished. No client feature requires hidden simulation fields before then. |
| Async advance wrapper, pinned priority-100 item and optional record | [server.ts:20](../../src/boxes/race/server.ts#L20) | a | Keep absent record distinct from JSON null. No async host function is actually called. |
| Setup, Cast names/portraits/source Character, human control seat, enabled/disabled state | [client-window.tsx:63](../../src/boxes/race/client-window.tsx#L63), [client-window.tsx:78](../../src/boxes/race/client-window.tsx#L78), [client.tsx:19](../../src/boxes/race/client.tsx#L19) | b | Enlarge the safe read projection. Existing `RaceRead` does not include all these values; do not send the entire ConversationSummary or other Boxes' setups. |
| Setup draft, conflicts, stat writes attached to adding a runner | [client-window.tsx:100](../../src/boxes/race/client-window.tsx#L100), [useBoxSetupDraft.ts:45](../../src/client/box-windows/useBoxSetupDraft.ts#L45) | b | `commit` with optional setup, Participant stats and optional source Character stats in one transaction. Preserve draft across refusal and refresh Character revision before retry. |
| Image upload and Library avatar revision guard | [client-window.tsx:117](../../src/boxes/race/client-window.tsx#L117), [shared-data.ts:35](../../src/boxes/race/shared-data.ts#L35) | b | `uploadImage`, scoped display and guarded Library commit. Persist hash in the shape the host's orphan accounting recognizes. |
| Window, status and composer Move staging | [client.tsx:29](../../src/boxes/race/client.tsx#L29), [client.tsx:57](../../src/boxes/race/client.tsx#L57) | b | Window frame + status projection + `stageMoves`; never expose the current all-Box MoveStaging map. |
| React SDK controls, Portrait, SVG oval and replay | [client-window.tsx:3](../../src/boxes/race/client-window.tsx#L3), [client-window.tsx:134](../../src/boxes/race/client-window.tsx#L134) | b | HTML controls/SVG inside frame; scoped image URLs and focal positioning replace Portrait/imageSrc. Local UI assets can be prepackaged; importing host React components is refused. |
| Read refresh and stale placeholder gating | [useBoxRead.ts:15](../../src/client/box-windows/useBoxRead.ts#L15), [client.tsx:40](../../src/boxes/race/client.tsx#L40) | b | Bridge projects revision and loading/stale state, pushes invalidations. Keep markers mounted but disable staging/stat creation while stale. |
| Descriptor schemas, Participant references, Move label function | [shared-descriptor.ts:6](../../src/boxes/race/shared-descriptor.ts#L6) | b | Trusted schema registration from declarative guest metadata; label rendering cannot be serialized as a function in a descriptor. Preserve row-reference metadata for Fork. |

## Memory dependency inventory

| Dependency | Source | Class | Sandbox answer |
|---|---|---|---|
| Digest-only records, no fold/initial/setup; four preceding Messages | [server.ts:11](../../src/boxes/memory/server.ts#L11) | a | State is absent, not `{}`. Host supplies source plus up to four preceding selected passages, seed, Cast and own Chat values. |
| Dependency capture and custom freshness fingerprint | [server.ts:12](../../src/boxes/memory/server.ts#L12), [server-recall.ts:152](../../src/boxes/memory/server-recall.ts#L152), [server-recall.ts:188](../../src/boxes/memory/server-recall.ts#L188) | b | Synchronous snapshot queries for settings, labels, active variants and model metadata. Keep custom fingerprint semantics; do not hash all serialized dependencies instead. |
| Library settings and Chat settings/labels | [server-chat.ts:13](../../src/boxes/memory/server-chat.ts#L13), [server-settings.ts:25](../../src/boxes/memory/server-settings.ts#L25) | b | `snapshot` and `commit`; Chat revision token includes instance, Library revision is numeric today. Preserve separate label and settings revisions. |
| Raw `Database`, Drizzle and self-selected Box id | [server-chat.ts:17](../../src/boxes/memory/server-chat.ts#L17), [server-settings.ts:56](../../src/boxes/memory/server-settings.ts#L56) | c | Bound storage capability. These APIs take a Box id, **not a literal namespace string**; the SDK adds `box:`. |
| Immediate transactions and revision guard callbacks | [server-memories.ts:47](../../src/boxes/memory/server-memories.ts#L47), [server-memories.ts:76](../../src/boxes/memory/server-memories.ts#L76), [server-memories.ts:88](../../src/boxes/memory/server-memories.ts#L88), [server-settings.ts:40](../../src/boxes/memory/server-settings.ts#L40) | b | Snapshot token + declarative atomic commit replaces transaction callbacks. Membership/existence validation must still hold at commit. |
| Nine custom Elysia routes with response/body schemas | [server-routes.ts:26](../../src/boxes/memory/server-routes.ts#L26) | c | Four read queries: settings, memories, sources, allowance. Five commands: settings save, identity, merge-labels, allowance save, note. Host provides routing, status mapping and validation. |
| Profile-format validation and resolved embedding configuration | [server-settings.ts:33](../../src/boxes/memory/server-settings.ts#L33), [server-settings.ts:63](../../src/boxes/memory/server-settings.ts#L63), [embedding.ts:15](../../src/server/box/embedding.ts#L15) | c | `models` and trusted picker. No arbitrary profile-id lookup. Configuration is a class with private secrets and public endpoint/profile metadata, not a usable JSON DTO. |
| Model completion by profile id | [server-extraction.ts:101](../../src/boxes/memory/server-extraction.ts#L101) | b | Granted `complete`. Keep model availability and finish-reason errors. |
| Streaming output byte cap, deadline, TextEncoder and AbortSignal | [server-extraction.ts:123](../../src/boxes/memory/server-extraction.ts#L123) | b | Host-enforced maxOutputBytes/deadline; no need to bridge a streaming callback merely to count bytes. UTF-8 byte count must match current behavior. |
| Decision metadata, batching, typed answers | [server-extraction.ts:201](../../src/boxes/memory/server-extraction.ts#L201), [server-extraction.ts:262](../../src/boxes/memory/server-extraction.ts#L262), [server-recall.ts:107](../../src/boxes/memory/server-recall.ts#L107) | b | `models` + `decide`; pure packing library stays guest-side. Reconstruct Map from answer entries or port `.get` callers. |
| Embedding warmed on digest; scene and all claims embedded on recall | [server-extraction.ts:272](../../src/boxes/memory/server-extraction.ts#L272), [server-recall.ts:250](../../src/boxes/memory/server-recall.ts#L250) | b | Granted `embed`, host cache. Local sibling cancellation via group; inherited job cancellation. |
| Cosine ranking, 96-candidate duplicate suppression, 48 semantic + 16 recent shortlist | [server-recall.ts:220](../../src/boxes/memory/server-recall.ts#L220), [server-recall.ts:265](../../src/boxes/memory/server-recall.ts#L265) | a | Pure math today executes in the Box via an SDK helper. JSON vectors work functionally; host vector operations are a possible performance extension. |
| Chat alternatives, authors, removed Participants, revision, active variants | [server-memories.ts:16](../../src/boxes/memory/server-memories.ts#L16), [server-chat.ts:30](../../src/boxes/memory/server-chat.ts#L30), [server-recall.ts:153](../../src/boxes/memory/server-recall.ts#L153) | b | Scoped read-only Chat snapshot; selected-path-only access is insufficient for inspector alternatives and captured author names. |
| Own slots outside fold, effective claims/status, source existence and fingerprints | [server-memories.ts:19](../../src/boxes/memory/server-memories.ts#L19), [server-sources.ts:13](../../src/boxes/memory/server-sources.ts#L13) | b | Own-instance record queries; validate requested Variant ownership. Host returns JSON entries, not Map. Hashing stays deterministic. |
| Catch-up progress, lifecycle and model-ready state | [server-memories.ts:40](../../src/boxes/memory/server-memories.ts#L40) | b | `snapshot`/`models`; queue progress requires invalidation beyond Chat revision. |
| Literal prompt items, allowance and stored activation trace | [server-prompt.ts:6](../../src/boxes/memory/server-prompt.ts#L6) | a | Preserve priority, literal flag, allowance, trace schema and item ordering. Trace strips claim/attribution from candidate entries, not the captured scene. |
| InvalidConversationCommandError and route domain errors | [server.ts:19](../../src/boxes/memory/server.ts#L19), [server-errors.ts:9](../../src/boxes/memory/server-errors.ts#L9), [server-routes.ts:32](../../src/boxes/memory/server-routes.ts#L32) | b | Typed JSON error/outcome envelope mapped to native errors/status by host. Guest Error identity does not cross realms. |
| Inspector gets effective stored claims including judgments/evidence | [server-memories.ts:28](../../src/boxes/memory/server-memories.ts#L28), [contract.ts:30](../../src/boxes/memory/contract.ts#L30), [client-use-memories.ts:77](../../src/boxes/memory/client-use-memories.ts#L77) | b | Explicit inspector projection. It currently receives record contents, although not the complete automatic/writer slot. Preserve unlabelled originals for edits and expected-record checks. |
| TraceView receives BoxTrace and separately reloads current sources | [client-trace.tsx:34](../../src/boxes/memory/client-trace.tsx#L34), [server-sources.ts:18](../../src/boxes/memory/server-sources.ts#L18) | b | Trace projection must include own captured trace, budget admission, automatic/final text comparison and source query results. Keep fingerprint mismatch behavior when a claim changes. |
| Inspector, Settings, ParticipantSection, TraceView | [client.tsx:10](../../src/boxes/memory/client.tsx#L10) | b | Four slots, plus navigation/focus/save-guard events. Trace remains viewable after disablement. |
| Application connection settings query and ProfileModelPicker | [client-settings.tsx:13](../../src/boxes/memory/client-settings.tsx#L13), [client-settings.tsx:103](../../src/boxes/memory/client-settings.tsx#L103) | c | Trusted picker and granted metadata; no entire connection-settings object in frame. |
| Writer edits/removal/reset, Remember/Retry, catch-up/cancel | [client-use-memories.ts:78](../../src/boxes/memory/client-use-memories.ts#L78), [client-use-memories.ts:94](../../src/boxes/memory/client-use-memories.ts#L94) | b | `recordCommand` and `digestCommand`. Do not expose generic `runConversationCommand` to the guest. |
| Changes subscription, query cancellation and optimistic local updates | [client-use-memories.ts:13](../../src/boxes/memory/client-use-memories.ts#L13), [client-trace.tsx:44](../../src/boxes/memory/client-trace.tsx#L44) | b | Versioned projection updates and cancellable read requests. Host signals digest/catch-up progress independently of Chat revision. |
| Schemas, Fork references, image-anchor projection, tokenx, hashing | [contract.ts:1](../../src/boxes/memory/contract.ts#L1), [server-recall.ts:1](../../src/boxes/memory/server-recall.ts#L1), [server-extraction.ts:250](../../src/boxes/memory/server-extraction.ts#L250) | a | Portable pure support library, with declared row-reference annotations retained. Node-backed hash implementation must be replaced or wrapped. |

## SDK audit

Verified entrypoints: [server.ts](../../src/box-sdk/server.ts), [shared.ts](../../src/box-sdk/shared.ts), [client.ts](../../src/box-sdk/client.ts). Production Memory code uses SDK entries and local files for host access. Direct `../../server/...` imports found in Memory are tests; they are not evidence of a production boundary violation. `bun:sqlite` imports in Memory are types; the actual raw handle is supplied by the host and used at runtime through Drizzle and `database.transaction`.

Every DB-taking function exported by the server SDK is accounted for below. Raw means either Bun Database or a Drizzle database wrapper; both expose host authority.

| Export(s) | Owning implementation | Bound replacement |
|---|---|---|
| `conversationExists`, `readConversationRevision` | [conversation/index.ts](../../src/server/conversation/index.ts) | Bound Chat existence/revision in snapshot; no caller-selected Chat. |
| `readChatVariants`, `readMessageAuthors`, `readParticipants`, `readActiveVariantIds`, `readExistingSources` | [variant-read.ts:20](../../src/server/conversation/variant-read.ts#L20) | Scoped snapshot queries; preserve alternative variants, active filtering, removed Participants and source ownership checks. Set becomes ids array. |
| `readMessageMoves` | [moves.ts:32](../../src/server/box/moves.ts#L32) | Current export reads all loaded Boxes' Moves. Only own Moves may be exposed. Neither landmark needs this extra server capability; Race already gets its Moves as input. |
| `readRecordSlots` | [records.ts:26](../../src/server/box/records.ts#L26) | Own-instance, schema-bound slots after validating ids belong to Chat. Existing helper itself accepts arbitrary Variant ids and has no Chat argument. |
| `readBoxLifecycles` | [setup.ts:31](../../src/server/box/setup.ts#L31) | Only own lifecycle/instance. Current return covers all Boxes. |
| `readBoxCatchUp` | [digest.ts](../../src/server/box/digest.ts) | Own Chat/Box queue status. Still takes a database even though queue state is in memory. |
| `readBoxDecision`, `readBoxDecisionSettings` | [decision-settings.ts:16](../../src/server/box/decision-settings.ts#L16) | Own model grant metadata/token budget, no profile id or unrelated selection. |
| `readChatValue`, `putChatValue` | [stored-value.ts:104](../../src/server/box/stored-value.ts#L104) | Declared keys; bound identity and Chat; instance-aware revision guard; write through commit. |
| `readLibraryValue`, `readLibraryValues`, `putLibraryValue` | [stored-value.ts:49](../../src/server/box/stored-value.ts#L49) | Own Library scope; schema/key/prefix allowlist; guarded commit. Library storage is necessary for both landmarks. |
| `readParticipantValues`, `readCharacterRevisions` | [stored-value.ts:64](../../src/server/box/stored-value.ts#L64) | Own keys on bound Chat Participants and their allowed source Characters. Race needs both. Character/Participant writes occur through conversation commands, not exports in this server SDK. |
| `readProfileApiFormat`, `readEmbeddingConfiguration` | [persistence.ts:42](../../src/server/connection-settings/persistence.ts#L42), [embedding.ts:36](../../src/server/box/embedding.ts#L36) | Refuse arbitrary configuration lookup; grant metadata and opaque resolved handle. |

Other server exports are types or pure computations/error presentation: `effectiveRecord`, `slotStatus`, `seededFraction`, `decisionRequest`, `largestFittingBatch`, `packDecisions`, `cosineSimilarity`, `tokenxEstimator`, `sha256`, `InvalidConversationCommandError`, `presentDomainError`. Pure does not imply directly importable in QuickJS: [sha256](../../src/server/hash.ts#L1) and [seededFraction](../../src/server/box/seed.ts#L17) use Node crypto; `presentDomainError` creates Elysia responses and requires native `instanceof Error` ([domain-error.ts:28](../../src/server/contract/domain-error.ts#L28)). Expose values and outcomes rather than these implementations.

Shared exports contain schema helpers, Box value decoding, status helpers, image-anchor handling and Row Reference schemas. `describeMoves` embeds a label function, and TypeBox schemas contain symbol-keyed kinds; a JSON descriptor cannot be passed unchanged to the present loader. Host reconstruction must preserve known schema kinds and `rowReference`/Participant-key metadata ([box-row-reference.ts:3](../../src/shared/contract/box-row-reference.ts#L3)); accept no executable schema callbacks.

Client exports are not a sandbox SDK. They include React components/hooks, generic conversation commands, application settings queries, Eden clients, shared query invalidation, digest routes, image upload/display and navigation-related props. Replace the used operations with the bridge above; do not re-export this module into the frame or VM.

## Hook semantics and call sites

### Synchronous calls cannot quietly become Promises

| Hook/operation | Verified call site | Boundary requirement |
|---|---|---|
| `setupError` | [set-box-setup.ts:22](../../src/server/conversation/commands/set-box-setup.ts#L22) | Sync inside command transaction, before any setup/stat write. |
| `moves.render` | [moves.ts:19](../../src/server/box/moves.ts#L19) | Sync while constructing history text. Disabled/removed Box uses stored Move labels. |
| `records.fold` | [records.ts:63](../../src/server/box/records.ts#L63) | Sync reduce from initial, one call per selected Variant with an effective record, current instance only. |
| `dependencies`, `advance.fingerprint` | [registry.ts:198](../../src/server/box/registry.ts#L198), [registry.ts:215](../../src/server/box/registry.ts#L215) | Sync within the capture snapshot; Promise would become a dependency object or an invalid fingerprint. |
| `read` / digest `status` | [box-window.ts:14](../../src/server/contract/box-window.ts#L14), [window.ts:18](../../src/server/box/window.ts#L18), [digest.ts:326](../../src/server/box/digest.ts#L326) | Sync read transaction. Existing digesting Boxes cannot declare `read` ([registry.ts:35](../../src/server/box/registry.ts#L35)). Sandbox surface projection must be a distinct adapter contract. |
| `advance.run` | [registry.ts:226](../../src/server/box/registry.ts#L226), [generate-capture.ts:447](../../src/server/workflows/generate-capture.ts#L447) | Awaited; Boxes advance in parallel after capture. Promise bridge fits. |
| `records.digest.run` | [digest.ts:130](../../src/server/box/digest.ts#L130) | Awaited; queue owns job identity, selected passage, four-message window, seed, own data and removed Cast members. |
| `upgrade` | [box-values.ts:33](../../src/server/conversation/box-values.ts#L33) | Sync; Promise output is explicitly rejected. Neither landmark defines it. |
| `routes` | [registry.ts:82](../../src/server/box/registry.ts#L82) | Sync Elysia factory at startup; replace entirely, not an async guest factory. |

[generate-capture.ts:290](../../src/server/workflows/generate-capture.ts#L290) wraps synchronous snapshot preparation in `runConversationReadTransaction`. Its [implementation](../../src/server/conversation/commands/transaction.ts#L98) is a synchronous SQLite transaction. A synchronous QuickJS bridge can call bounded local reads inside it. An asynchronously suspended VM or worker-RPC hook cannot simply hold that transaction open: pre-capture a closed read set or redesign capture around a versioned snapshot. Never perform network I/O in it.

Memory's custom fingerprint includes relevance threshold, allowance/settings revision, labels revision, embedding configuration and writer records. It intentionally excludes arriving automatic digests; a saved preview is not invalidated merely because background Memory work landed ([server-recall.ts:145](../../src/boxes/memory/server-recall.ts#L145), [server-recall.ts:221](../../src/boxes/memory/server-recall.ts#L221)). The host separately fingerprints setup/state/Moves and Decision identity. An opaque handle's random token must not replace the stable configuration identity: that would make every capture stale. Preserve separate source-snapshot evidence and preview freshness.

Effective records are `writer ?? automatic` ([records.ts:43](../../src/server/box/records.ts#L43)). A newer automatic result preserves the writer; reset removes the writer. Stale automatic records remain effective. Earlier Swipes/edits do not invalidate later resolved Race records. Removal/reinsertion changes instance so old records do not fold. Capture only supplies the current Box's slots, not another Box's state.

Trace is distinct from record: Memory's advance returns activation evidence plus prompt items/allowance, and no automatic Memory record; digest produces the record. Race advance produces a full state record and no trace. Preserve host admission evidence and the automatic/final text comparison as well as guest trace JSON.

Cancellation is behavior, not just a timeout. [services.ts:27](../../src/server/box/services.ts#L27) passes inherited abort signals and combines per-request limits; Memory cancels sibling embedding calls on failure. The digest queue aborts superseded jobs and checks current job, lifecycle and source content before landing a result ([digest.ts:81](../../src/server/box/digest.ts#L81), [digest.ts:123](../../src/server/box/digest.ts#L123)). Rejecting a guest Promise alone does not stop host network calls. Separate active CPU budget, wall-clock job deadline and provider deadlines; Memory permits up to ten minutes of extraction wait.

### Stored schemas and live replacement

Loading currently uses plain `import()` for both descriptor and server ([registry.ts:107](../../src/server/box/registry.ts#L107)); this is trusted execution. Startup checks stored values only when schema fingerprint changes ([schema-check.ts:33](../../src/server/box/schema-check.ts#L33)). Failing authored setup/Chat values/Participant values/Moves/writer records are held; failing automatic records and traces can be removed if not upgraded ([box-values.ts:45](../../src/server/conversation/box-values.ts#L45)). Library/Character values are not covered by that Chat-scoped schema walk; Race Library avatars and Memory Library settings need their own declared validation policy.

No-restart activation must do equivalent validation before publishing a new generated version, bind in-flight jobs to their version and revoke old handles when retired. Do not treat “changed JavaScript” as only a UI refresh. Neither landmark has an upgrade hook; supporting arbitrary migration code is unnecessary for the first port. Explicitly clear incompatible development data if that is the chosen policy, rather than silently accepting it.

## Client projections and leakage

Verified props in [client registry](../../src/client/box-windows/registry.ts#L26):

- Panel: `visible`, `conversation`, `disabled`, `staging`, `boxData`, `onConversationChange`. Status: `conversation`.
- Inspector: `conversation`, `onConversationChange`, `focusRequest`, `onClose`, `onNavigateSource`, `onOpenSettings`, `onOpenConnections`.
- Settings: no props; Memory fetches global settings itself.
- ParticipantSection: `conversation`, `participant`.
- TraceView: `conversationId`, `trace`, optional `onNavigateSource`.

Functions, React components and the whole ConversationSummary must not be serialized as frame props. Use projected data and named events. Replace SDK controls with frame-local HTML/CSS/JS; no build step implies rewriting these TSX clients or supplying an already-built generic UI library, not loading TSX directly. Port SaveGuard's dirty/save/discard behavior, setup conflict handling and placeholder loading explicitly. Portrait becomes an image with a granted URL and focal-position styles.

Race's existing read strips hidden intents and replay correctly. However, “only the existing read output is needed” is false: the client separately reads setup, seats, portraits and staged Moves. An expanded read projection can cover them without raw state. The record API must stay server-only; otherwise it would bypass `spectatorOf`.

Memory has no folded state to leak. Its inspector deliberately receives all effective claim contents, including evidence and judgment probabilities, and uses originals for writer edits. TraceView directly receives the stored activation trace, including captured scene, while fetching projected current source records to check fingerprints. It does not receive complete automatic/writer slots. Therefore “never raw state” is achievable, but “never any record contents” would remove existing Memory features. Funnel approved claim/trace projections through the sandbox surface read instead of forwarding host objects.

An untrusted server hook can intentionally copy any data it can read into its `read`, prompt items, trace or model request. Projection alone is not an enforced secrecy policy between the generated logic and its own UI. Race's hidden-intent discipline is code behavior; if adversarial code must be prevented from exposing a secret, do not give that code the secret.

Inference for the iframe: `sandbox="allow-scripts"` gives an opaque origin, not a network policy. Bind messages to the exact frame/MessagePort and instance; `origin === "null"` alone is insufficient. Restrict network/navigation/resource loading with a deliberate CSP and asset policy so a frame cannot send projected Chat data to arbitrary endpoints or call ambient host routes. A `command` result is also an output channel: return only outcomes and approved projections, never storage/service internals.

## Performance and QuickJS risks

Verified: `readBoxFold` has no fold-result cache. It reloads current-instance slots and reduces the provided selected Variant ids on each generation capture/window read/digest-status read. It does not fold every alternative Variant; Memory's inspector explicitly reads alternatives separately. React query reuse/placeholder caching does not turn this into a server fold cache.

Race's fold is effectively an O(1) reference choice natively, but each record contains cumulative replay ([server-engine.ts:260](../../src/boxes/race/server-engine.ts#L260)). A naive JSON round trip for every fold copies growing state repeatedly. With R runners and T recorded Stretches, cumulative replay data across records grows roughly O(R*T²); this is structural inference, not measured latency. Keep state inside one VM for a bounded fold batch and serialize the final result once if the adapter permits it. Loading/validating the stored records still costs work.

Memory scans all selected eligible sources, hashes path content and creates every claim candidate before recall. A scene uses at most four messages and a 4,000-token limit; extraction takes one source and four preceding messages, then trims context to its limits. Those bounds do **not** bound the entire captured history or total claims. Inspector reads include alternatives. There is no per-chat claim cap in the record schema ([contract.ts:16](../../src/boxes/memory/contract.ts#L16)); automatic extraction caps one response at 16 candidates.

Vector math runs in the Box: similarity for every claim, sorting, then pairwise near-duplicate checks among the closest 96 (threshold 0.95), at most 48 semantic choices, union with 16 recent, then one fitting Decision batch. Complexity is roughly O(N*D + N log N + 96²*D), with early exits in duplicate checks. The host currently only fetches/caches vectors and supplies the cosine helper.

Payload estimate, **not a benchmark**: the source comment in [embedding.ts:49](../../src/server/box/embedding.ts#L49) describes a recall of about 1,700 vectors with 3,072 dimensions. That is 5,222,400 floats, about 19.9 MiB binary Float32 payload. Assuming 12–22 JSON bytes per number including separator, vectors alone become about 60–110 MiB, before host strings, guest parsing/arrays and copies. The comment reports historical conversion cost (142 ms out of 210 ms cache time); these numbers were not reproduced here. A default small VM heap is not credible for that workload.

For history, N selected messages averaging P bytes of prose cost at least N*P; the current CaptureRead carries both `content` and `prose`, often nearly duplicating it. Example assumption: 1,000 messages at 2 KiB each is about 4 MiB just for the two text fields, plus records/metadata. At 1,700 claims averaging 1 KiB serialized, records add about 1.7 MiB; writer and automatic slots may duplicate them. These are planning examples, not observed chat sizes.

If large Memory recall is a requirement, consider `embed(handle, texts, options): Promise<VectorBatchHandle>` plus `cosineRank(queryHandle, candidateHandle, ids): Ranked[]` and `cosinePairs(handle, pairs): number[]`. Bound handles to invocation, retain Float32 vectors on the host, and keep Memory's shortlist/dedup policy in guest code. This is an optional performance capability, not a proven minimum; benchmark before choosing it. Returning just nearest neighbors without duplicate comparisons would change behavior.

[QuickJS upstream README, Promises](https://github.com/justjake/quickjs-emscripten#promises) explicitly supports `newPromise()` handles, `resolvePromise()` and host-driven `executePendingJobs()` in the normal build. [Asyncify](https://github.com/justjake/quickjs-emscripten#asyncify) exists for asynchronous host operations that look synchronous to guest code; one WASM module can suspend on only one operation at a time. This matters for concurrent Box advances, two digest workers and Memory's `Promise.all` embeddings. Prefer the Promise bridge and bound job pumping. Upstream lists Bun support, but loading under **Bun 1.4.4 was not empirically tested here**.

Other boundary requirements:

- Standard JS globals are present; “empty globals” should mean no ambient host APIs. Date/randomness and mutable module state can break replay determinism even with no I/O. Specify seed-only randomness and invocation lifetime.
- JSON does not preserve root undefined, Map, Set, Float32Array, Error, AbortSignal or EmbeddingConfiguration's private fields. Use explicit absence/result tags and DTOs, and preserve numerical semantics.
- A Memory embedding configuration is deliberately non-JSON: private credentials stay in its native class, and a custom fingerprint allows non-JSON dependencies. Serialization loses the private capability even though public fields survive. Resolve an opaque handle on the host, never reconstruct from guest-supplied endpoint fields.
- QuickJS heap limits do not bound host JSON serialization, provider buffers, storage queries, uploads or iframe memory. Validate/bound both directions. Interrupt VM execution and promise-job loops; enforce separate host service limits.
- No runtime measurement establishes speed, exact engine parity, tokenx portability or Bun loading in this note. Test representative long histories, numeric output equality, cancellation and handle disposal before declaring the port ready.

## E2E impact

All listed files were read; no specs were run. These are port expectations, conditional on preserving Box identity and accessible labels.

| Spec | Changes | Assertions to retain |
|---|---|---|
| [race/race.spec.ts:11](../../src/boxes/race/race.spec.ts#L11) | Frame locators for setup/race controls. Host dock/minimize/composer/preview remain host locators. | Same Stretch text, Swipe equality, re-roll difference, later-record retention, Results and terminal absence. |
| [race/lifecycle.spec.ts:17](../../src/boxes/race/lifecycle.spec.ts#L17) | Frame locators for Race controls and dropdown options. | Removal preserves prose/Move labels; disabled rendering no longer emits live Move intent; model request assertions identical. |
| [race/preset-block.spec.ts](../../src/boxes/race/preset-block.spec.ts) | Frame locators only for setup controls; preset HTTP helpers and host enable notice stay if identities/routes are retained. | Preset insertion/off behavior and exact Prompt Plan Stretch content. |
| [race/moves.spec.ts:10](../../src/boxes/race/moves.spec.ts#L10) | Frame locators **and** adapt delayed-read interception if projection transport replaces `/boxes/race`. | Stale Move controls disabled, Moves-only Send, intent in history, same Swipe outcome, Auto fizzle. |
| [race/cast.spec.ts:15](../../src/boxes/race/cast.spec.ts#L15) | Frame locators; adapt direct Race-read endpoint and raw Box command fixtures if transport/identity changes. A protocol error no longer necessarily causes browser HTTP-422 console output, so update `allowedBrowserErrors`. | Stats copy at seeding, Character isolation, atomic refusal and successful retry without losing draft. |
| [memory/memory.spec.ts:6](../../src/boxes/memory/memory.spec.ts#L6) | Model-grant setup replaces profile-id/custom-route fixture; inspector/trace/dialogs use frame locators. | Retained claim appears in actual model request; rejected claim absent; source excerpts, stale-source fingerprint behavior, writer override/reset and disabled inspectability unchanged. |
| [memory/inspector.spec.ts:3](../../src/boxes/memory/inspector.spec.ts#L3) | Four frame surfaces and revised settings read assertion/transport. Host navigation/Generation shell stays outside. | Off-state settings and identity editing, disabled Remember, trace visible in preview/active/saved Generation after disabling. |

Only some tests are selector-only. In particular Memory custom HTTP fixtures and Race's network interception are transport-dependent. Prompt Plan compilation, pinned/literal semantics, budgets and fake-provider request matching should stay identical; changing the expected story result to accommodate the VM would hide a semantic regression. If all children are renamed `box:sandbox`, block-id selectors/fixtures also change—another reason to settle child identity before porting tests.

## Corrections and unresolved decisions

1. Memory has **nine**, not eight, custom routes: four GET and five POST.
2. Memory's direct host-internal imports are in tests. Production reaches host operations through SDK exports; it also imports shared SDK and package/runtime types, not only server SDK.
3. `"memory"` is a self-chosen **Box id** passed to helpers, which derive `box:memory`; it is not a freely spelled namespace parameter. This is still too much authority for untrusted callers.
4. Asyncify is not required for async model services. A normal-build Promise bridge fits the already-async hooks.
5. Memory dependencies are not wholly JSON today: EmbeddingConfiguration is a private-field class. Decision answers are Maps and embeddings are Float32Arrays. These need real protocol adaptation.
6. Race's engine is pure, but its server module imports Node util and its full UI needs more than current `RaceRead`. Library/Character access is part of the landmark, not optional decoration.
7. Memory inspector receives effective record contents and TraceView receives raw stored activation evidence. Neither receives a folded state; Memory has no fold. “Only read output” requires a new projection for these surfaces.
8. Existing digesting Box `read` prohibition, per-child identity and schema activation are host architecture questions, not solved by adding command handlers.
9. A generated Box that may read story content may intentionally emit it. Decide whether confidentiality is against other Boxes, the guest UI, remote endpoints, or all three; those require different capability grants.
10. Decide whether source-Character writes and Box-global Library settings are granted to generated Boxes. Refusing them is a coherent restriction, but then Race/Memory do not port feature-for-feature.
11. Decide snapshot execution placement before selecting worker isolation or asyncify. Preserve atomic capture/commit semantics without a guest-held asynchronous database transaction.
12. Benchmark vector crossing and cumulative Race records before setting budgets. No empirical QuickJS performance claim is made here.
