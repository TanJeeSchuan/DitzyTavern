# App action performance audit

2026-10-30 · source revision `985c40c3`

This audits application actions: opening chats, sending/continuing/regenerating, watching output, editing, using Boxes, importing, forking, and uploading images. It does not audit test-suite performance. Findings are traced through current source; no production timings, provider calls, or browser profiles were collected. Priorities below are engineering judgments, not measured rankings. Application code was not changed.

The recurring problem is repeated work over unchanged data: reading prose merely to derive a boolean, rebuilding history-derived state, copying shared evidence into many records, and invalidating views without knowing which data changed. Eliminating that work is a better starting point than replacing Bun, SQLite, the ORM, or React.

## What is already efficient

- Lore evaluation and Box advancement already overlap, and Boxes advance concurrently: [generate-capture.ts:440](/home/tan/Projects/DitzyTavern/src/server/workflows/generate-capture.ts:440), [registry.ts](/home/tan/Projects/DitzyTavern/src/server/box/registry.ts).
- Digestion already runs in the background; generation does not await extraction catch-up: [digest.ts:21](/home/tan/Projects/DitzyTavern/src/server/box/digest.ts:21).
- History is paginated, discarded Variant prose is omitted from its response, and selected-history capture requests only selected Variants. The remaining opportunity is in the database reads behind those projections: [history.ts:167](/home/tan/Projects/DitzyTavern/src/server/conversation/history.ts:167), [selected-history.ts](/home/tan/Projects/DitzyTavern/src/server/conversation/selected-history.ts).
- History-budget trimming already uses binary search. Macro expansions are already cached within an attempt: [budget.ts:155](/home/tan/Projects/DitzyTavern/src/server/prompt-compiler/budget.ts:155), [admission.ts:59](/home/tan/Projects/DitzyTavern/src/server/generation-plan/admission.ts:59).
- Cached embedding vectors already use Float32Array views; images already have immutable caching; generation checkpoints already avoid triggering the ordinary change feed when no prior write is pending: [embedding.ts:47](/home/tan/Projects/DitzyTavern/src/server/box/embedding.ts:47), [image.ts:24](/home/tan/Projects/DitzyTavern/src/server/contract/image.ts:24), [changes.ts:69](/home/tan/Projects/DitzyTavern/src/server/database/changes.ts:69).

## Direct improvements

### 1. Overlap Memory's independent embedding work

**Action:** Send, Continue, Sibling, or inspect a prompt with configured Memory and recallable claims.

[server-recall.ts:249](/home/tan/Projects/DitzyTavern/src/boxes/memory/server-recall.ts:249) awaits all claim embeddings, then starts the scene embedding. Neither embedding depends on the other; similarity scoring needs both. Cache misses put two independent remote stages in series. On a warm cache, [embedTexts](/home/tan/Projects/DitzyTavern/src/server/box/embedding.ts:69) still reads all claim vectors before the scene request starts.

Start the scene request first, start cached/missing claim embedding work, and await both together. Preserve cancellation and propagate either failure. This is a small local change with the clearest critical-path benefit when claims are uncached. Provider concurrency limits can reduce the benefit; the relevance Decision Model must still wait for ranking.

Separately, semantic Lore processes requests in pairs, awaiting both before starting the next pair: [semantic.ts:80](/home/tan/Projects/DitzyTavern/src/server/lorebook/semantic.ts:80). Replace that barrier with two workers taking the next request as each finishes. This keeps the current concurrency ceiling while avoiding an idle slot behind a slow partner. It matters only when there are multiple batches with uneven completion times.

**Verify:** Observe when requests start under delayed scripted responses; then measure click-to-provider-start with warm and cold embeddings. This verifies application scheduling, not test-runner speed.

### 2. Stop loading text just to throw it away

**Action:** Open/history-refresh a chat with many swipes or long reasoning; generate in a long chat.

The history loader selects every Variant's complete content: [message-rows.ts:24](/home/tan/Projects/DitzyTavern/src/server/conversation/message-rows.ts:24). History also loads complete reasoning strings for all returned Variants, then mostly uses them for `hasReasoning`; only selected/live prose is sent: [history.ts:129](/home/tan/Projects/DitzyTavern/src/server/conversation/history.ts:129), [history.ts:155](/home/tan/Projects/DitzyTavern/src/server/conversation/history.ts:155). The existing detail endpoint already loads a Variant's actual prose and reasoning on demand.

Introduce a purpose-built history projection: Variant metadata, SQL-derived empty/reasoning flags, and text only for selected/live Variants. Keep raw row loading for callers that truly need raw rows. Also replace the per-message `variantRows.find(...)` with the already grouped variants or a selected-by-message map: [history.ts:193](/home/tan/Projects/DitzyTavern/src/server/conversation/history.ts:193).

Generation capture loads reasoning for every selected Variant alongside macro writes: [generate-capture.ts:308](/home/tan/Projects/DitzyTavern/src/server/workflows/generate-capture.ts:308). The reasoning consumer in this capture is continuation eligibility for the final Variant. Load that boolean only for a continuation; keep macro writes for the selected path.

**Verify:** Query/result bytes and allocation profiles with long unused swipes/reasoning. The visible history, swipe metadata, continuation eligibility, and lazy detail text must remain identical. A SQL flag saves JS transfer/materialization, not necessarily all SQLite page reads.

### 3. Read and verify imported bytes once at commit

**Action:** Commit a staged SillyTavern import.

`assertStagedAvailable` reads and hashes the complete file, then commit immediately reads it again to decode it: [staged.ts:155](/home/tan/Projects/DitzyTavern/src/server/sillytavern/staged.ts:155), [staged.ts:455](/home/tan/Projects/DitzyTavern/src/server/sillytavern/staged.ts:455).

Collapse verification and byte loading into `readVerifiedStagedBytes`, returning the verified buffer to decoding. Remove the second read. This also makes verification and decoding use the same bytes. For large imports, the next step is asynchronous file I/O and a worker for parsing/projection; merely adding `async` does not move JSON parsing or synchronous SQLite work off the server event loop.

**Verify:** One commit file read; corruption/missing-file rejection and exact-source fidelity unchanged. Measure event-loop delay during a large import as well as import duration.

### 4. Send image bytes directly; overlap multi-image uploads

**Action:** Insert images or change a background.

The client converts a file to a data URL, extracts base64, and posts JSON; the server decodes that string back to bytes: [client/lib/image.ts:4](/home/tan/Projects/DitzyTavern/src/client/lib/image.ts:4), [contract/image.ts:12](/home/tan/Projects/DitzyTavern/src/server/contract/image.ts:12). The editor additionally awaits each upload in order before starting the next: [ProseEditor.tsx:123](/home/tan/Projects/DitzyTavern/src/client/editor/ProseEditor.tsx:123).

Replace the JSON/base64 contract with a binary File/Blob body and remove both conversions. Upload multiple files with a small concurrency bound while preserving insertion order. Keep ingestion validation, metadata stripping, content hashing, and the mapped insertion position.

**Verify:** Request bytes, peak memory, and completion latency for a large image and multi-file paste. Failed uploads and navigation must not insert references into the wrong editor.

## Refactors that remove repeated work

### 5. Make change notifications describe the change

**Action:** Watch Memory/Box windows while background digests, other chats, or unrelated settings write data.

The database broadcasts an undifferentiated change; every active query opting into `followsChanges` revalidates: [changes.ts:29](/home/tan/Projects/DitzyTavern/src/server/database/changes.ts:29), [server-changes.ts:30](/home/tan/Projects/DitzyTavern/src/client/server-changes.ts:30). These are currently Memory and Box timeline/status reads, not every application query. Each unchanged GET is fully computed, serialized, and hashed before returning 304: [content-validators.ts:33](/home/tan/Projects/DitzyTavern/src/server/contract/content-validators.ts:33).

There is a second coarse boundary: publishing any newer conversation revision invalidates all its history and Variant-text queries, including after a metadata-only change: [conversation-query.ts:28](/home/tan/Projects/DitzyTavern/src/client/conversation-query.ts:28).

Replace global invalidation with a committed change journal naming affected conversations, Boxes, messages, and settings. Derive it from durable writes/triggers where necessary, including plugin-owned connections; do not add a second optional writer-maintained notification path. Query dependencies then select what to invalidate. A query's complete dependency version can also answer 304 before reconstruction. Remove the blanket paths once the new contract covers them.

**Behavior:** Same freshness, fewer unrelated reads. External/plugin writes, cascades, reconnect, and in-flight changes must remain covered. A conversation revision alone is insufficient because some dependent data changes without bumping it.

**Verify:** Run Memory catch-up with several open windows; count route executions, bytes and client updates, including unrelated writes and a second SQLite connection.

### 6. Capture Lore once, match once, store shared evidence once

**Action:** Prepare or inspect generations with substantial Lorebooks.

The initial synchronous evaluation matches every entry and constructs evidence; the asynchronous semantic path assembles the evaluation again: [evaluation.ts:154](/home/tan/Projects/DitzyTavern/src/server/lorebook/evaluation.ts:154), [evaluation.ts:215](/home/tan/Projects/DitzyTavern/src/server/lorebook/evaluation.ts:215), [evaluation.ts:231](/home/tan/Projects/DitzyTavern/src/server/lorebook/evaluation.ts:231). Each entry's evidence repeats the entire scan window: [evaluation.ts:87](/home/tan/Projects/DitzyTavern/src/server/lorebook/evaluation.ts:87). This applies even to entries that do not activate. Literal matching lowercases messages per expression, and regex matching recompiles expressions: [matching.ts:89](/home/tan/Projects/DitzyTavern/src/server/lorebook/matching.ts:89).

Introduce one captured Lore input with shared scan messages, book metadata, compiled matchers, lexical results, and optional semantic results. Finalize activation/evidence once. Store the scan window once per activation; entries refer to it. Replace the existing evidence schema and its consumers rather than preserving both representations.

Keep lexical evidence and unavailable-semantic behavior identical. Precompute case-folded scan text once and reuse compiled regexes within the evaluation; a persistent matcher cache keyed by book revision is optional after measurement.

**Why this matters:** Evidence serialization currently duplicates scan text for every entry, and the same evidence enters preparation fingerprints. Shared references in JS alone do not solve this: JSON serialization must also use a normalized representation.

**Verify:** Serialized capture size, allocation/GC cost, regex compile count, and equivalent activation/inspection explanations on large books.

### 7. Separate generation inputs from UI summaries; incrementally derive story state

**Action:** Send/Continue/Sibling, validate an inspected prompt, open Box windows.

Generation begins with the full conversation UI summary: [generate-capture.ts:291](/home/tan/Projects/DitzyTavern/src/server/workflows/generate-capture.ts:291). That summary computes participant-removal eligibility, including reference/count queries per non-seated participant: [snapshot.ts:98](/home/tan/Projects/DitzyTavern/src/server/conversation/snapshot.ts:98). Generation does not need removal controls.

Capture then reads the selected history, macro writes, and Box records; Box state folds from the beginning each time: [records.ts:58](/home/tan/Projects/DitzyTavern/src/server/box/records.ts:58). Box windows independently read summary, history, and their fold: [window.ts:18](/home/tan/Projects/DitzyTavern/src/server/box/window.ts:18). Preview acceptance rebuilds a snapshot to compare its fingerprint, whose current representation serializes the snapshot with overlapping history projections: [generation-preview.ts:217](/home/tan/Projects/DitzyTavern/src/server/workflows/generation-preview.ts:217), [generation-preparation-fingerprint.ts:18](/home/tan/Projects/DitzyTavern/src/server/workflows/generation-preparation-fingerprint.ts:18).

Start small: a generation-specific snapshot without UI removal eligibility; aggregate removal calculations once when a UI summary actually needs them. Next, introduce a selected-path projection shared by generation and Box reads, with memoized immutable prefixes for macro state/Box folds. Replace full replay with recomputation from the earliest affected message after edit, swipe, deletion, or override.

Use an explicit dependency fingerprint rather than serializing the entire presentation snapshot. Include settings, preset, cast, selection, moves, author overrides, and Box instance/dependency versions. Preserve the existing rule that an automatic Memory digest landing does not stale an inspected prompt. Hashing the existing giant JSON only shrinks the result; it does not eliminate building the JSON.

**Do not simply truncate old history:** macros and Box state can depend on old messages even when prompt budgeting omits their prose. Preserve Box output validation at the plugin boundary.

**Verify:** Capture cost across growing histories, then equivalence after editing/swiping near the beginning and after background digests. This is the broadest architectural opportunity and also the highest invalidation burden.

### 8. Compile stable prompt parts once

**Action:** Prepare a prompt with many candidate Lore/Memory items or a large context.

Dynamic admission repeatedly measures the individual item, the growing admitted block, and a compiled trial plan: [admission.ts:26](/home/tan/Projects/DitzyTavern/src/server/generation-plan/admission.ts:26). With many admitted items, repeated concatenation and estimation revisit prefixes. History trimming is already binary search, but its trials still rebuild/measure candidate plans.

Introduce an immutable expanded prompt representation: stable blocks plus references to history and dynamic items. Cache stable text and image metadata within the capture; splice changing portions during admission instead of rebuilding everything. Replace the repeated compile/measure scaffolding with one budget planner over that representation.

Preserve macro execution order and once-only writes, pinned items, role placement, image deduplication, and the current estimator's actual decisions. Token estimates are not automatically additive across concatenation boundaries; use cached costs only where equivalence is established. Keep this behind measured evidence of compiler CPU cost rather than building an optimizer speculatively.

### 9. Localize streaming updates and parsing

**Action:** Watch a long answer while much history is loaded.

The session runner dispatches incoming events immediately: [generation-session-runner.ts:124](/home/tan/Projects/DitzyTavern/src/client/generation-session-runner.ts:124). `StoryStage` maps every loaded message, creates callbacks/React elements, and renders non-memoized message components: [StoryStage.tsx:171](/home/tan/Projects/DitzyTavern/src/client/workspace/StoryStage.tsx:171).

`Prose` parses all accumulated Markdown to find the reveal boundary, then parses the shown prefix again whenever that prefix changes: [prose.tsx:125](/home/tan/Projects/DitzyTavern/src/client/story/prose.tsx:125), [prose.tsx:189](/home/tan/Projects/DitzyTavern/src/client/story/prose.tsx:189). Existing sentence/chunk reveal gating and memoized HTML blocks help, but do not remove the reveal calculation's full parse.

First coalesce visual publications to animation frames while processing transport events and terminal state correctly; stabilize row props and memoize settled messages. Merely adding `memo` will not help if callback and ReactNode props change every time. Then collapse reveal-boundary calculation and rendering into one parse result. Consider incremental Markdown only if still necessary: later input can change earlier parsing through references or block structure, so a blank line is not universally a safe commit boundary.

**Verify:** Main-thread tasks, commits, input responsiveness, and event-to-visible-text latency. Preserve split Markdown/Box markup, replay deduplication, Stop/final flush, scroll anchoring, and the intended reveal animation. Browser profiling is required to quantify the benefit.

### 10. Bulk-copy forks instead of querying each nested row

**Action:** Fork or rewind a large chat.

Fork reads all messages then filters the requested prefix in JS. It queries Variants per message and metadata per copied Variant, inside one synchronous immediate transaction: [fork-conversation.ts:40](/home/tan/Projects/DitzyTavern/src/server/conversation/commands/fork-conversation.ts:40), [fork-conversation.ts:58](/home/tan/Projects/DitzyTavern/src/server/conversation/commands/fork-conversation.ts:58), [fork-conversation.ts:107](/home/tan/Projects/DitzyTavern/src/server/conversation/commands/fork-conversation.ts:107).

Push the fork-position bound into SQL. Bulk-read retained Variants and metadata, build id maps, rewrite references once, and use batched inserts where feasible. Remove per-parent SELECT loops. Preserve the atomic transaction, selected-Variant behavior, trim mode, and schema-directed Box reference rewriting. SQLite is local, so this saves statement/marshalling overhead rather than network round trips; large JSON copying may remain dominant.

**Verify:** Statement count, lock/transaction duration, concurrent chat responsiveness, and fork equivalence with Box records and trimmed Variants.

## Smaller or workload-specific opportunities

- **Editor keystrokes:** image chips stringify and parse the full document on every edit. Map existing decorations through the CodeMirror change set and rescan affected references/lines, including boundary-spanning edits: [ProseEditor.tsx:45](/home/tan/Projects/DitzyTavern/src/client/editor/ProseEditor.tsx:45).
- **Reopening Cast:** the character list uses a mount fetch and local state. Replace it with one query-cache entry refreshed by relevant mutations; browser revalidation alone still incurs the request and server computation: [CharactersPanel.tsx:48](/home/tan/Projects/DitzyTavern/src/client/characters/CharactersPanel.tsx:48).
- **Large Memory collections:** recall loads every vector, computes cosine similarity, and sorts the full candidate list to retain a small shortlist. Use bounded top-k selection; consider cached vector norms/normalized vectors keyed by embedding space. Repeated hashing and vector loading remain even after Float32Array allocation was fixed: [server-recall.ts:218](/home/tan/Projects/DitzyTavern/src/boxes/memory/server-recall.ts:218), [server-recall.ts:249](/home/tan/Projects/DitzyTavern/src/boxes/memory/server-recall.ts:249), [embeddings.ts:73](/home/tan/Projects/DitzyTavern/src/server/model-client/embeddings.ts:73). Near-tie ordering and zero vectors need care.
- **Startup with a large archive:** image cleanup scans potential references across every TEXT column before the app serves requests: [app.ts:37](/home/tan/Projects/DitzyTavern/src/server/app.ts:37), [store.ts:21](/home/tan/Projects/DitzyTavern/src/server/image/store.ts:21). A durable image-reference index could replace archive rescanning. It must cover Box/plugin values and checkpoint recovery; replacing the broad scanner without a complete ownership contract risks deleting referenced images. Profile startup before paying for that design.
- **Swipe prefetch:** adjacent text prefetch is deliberate latency hiding. Do not remove it just to lower request counts. Directional or idle prefetch is an option only if unused payloads matter more than instant swiping; see the [client audit](/home/tan/Projects/DitzyTavern/docs/research/action-performance-client-audit.md).

## Wild proposals

1. **Prepare the settled story before Send.** Maintain the selected-path projection, compiled Lore matchers, cached claim vectors and fixed prompt fragments while the writer is idle. Send adds the pending text and runs only its dependent work. Replace repeated synchronous reconstruction with a versioned preparation object. Do not speculatively send unsent drafts to providers. Discard stale work; never warm by executing macros or Box advances that belong to a new attempt. Tradeoff: background CPU/memory and exact dependency tracking.

2. **Make branches share immutable history.** Replace full fork copies with an immutable message/Variant graph and branch heads; divergence creates new nodes. Fork becomes a branch operation instead of archive duplication. This could also let prefix-derived state be shared. It requires changing mutable message ownership, participant references, deletion/garbage collection, and Box row-reference semantics. A major domain redesign, justified only if huge forks are common.

3. **Use local retrieval as the Memory decision.** Keep a resident vector index and retrieve diversified top candidates locally, removing the remote relevance judge from the generation path. Exact in-process top-k is a smaller first step; an approximate index is for genuinely large collections. Removing the judge changes which memories enter the prompt, so evaluate narrative relevance and false-positive recall, not just latency. Preserve a trace explaining selection. This is a product-quality tradeoff, not an equivalent refactor.

4. **Render a moving window of the story.** Replace the ever-growing mounted history list with a virtual viewport; use a per-Variant display accumulator for streaming. This bounds DOM/layout work as history grows. Variable heights, focus, text selection, browser find, images, and scroll anchoring are substantial costs. Try memoized rows and frame publication first; do not build a custom incremental Markdown parser merely because virtualization sounds ambitious.

## Recommended order and proof

Start with independent embeddings, narrow history/reasoning reads, verified import bytes, and binary images. They remove identifiable work with limited redesign. Next profile streaming, Lore evidence size, and Box catch-up invalidation; choose the largest observed cost. Introduce incremental selected-path state only when measurements justify its invalidation complexity. Keep shared-history forks and judge-free Memory as experiments.

Measure actions rather than isolated helper throughput: click-to-provider-request, provider-request-to-first-event, first-event-to-visible-prose, completion-to-settled-UI, open-chat latency, swipe latency, typing responsiveness, fork/import duration, and event-loop delay. Record query counts, returned bytes, provider request starts, compilation allocations, and React commits alongside timings. Separate warm/cold embedding caches, small/long selected paths, many unused swipes, large Lorebooks, and active digest catch-up. Use controlled provider delays to isolate local work, then repeat against the configured provider for realistic end-to-end behavior. Keep errors and cancellations in the results.

No numerical speedup is claimed by this audit. No app or e2e servers were started, no user data was changed, and no application tests were changed or run.
