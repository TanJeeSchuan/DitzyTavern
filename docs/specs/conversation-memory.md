# Conversation-local story memory and character knowledge

## Problem Statement

In a long Chat, older Messages eventually fall outside the model's context window. The writer must repeat past events, relationships, promises, and character knowledge to maintain continuity. A recollection that loses attribution can also turn an accusation into a fact, mistake hearing for belief, or let a character act on information they have never learned.

The writer needs automatic, best-effort Memory within each Conversation, with inspectable evidence and direct correction. The Conversation remains the original record. Editing an earlier scene must preserve the writer's retained later writing and its Memories, even when the resulting story is inconsistent.

## Solution

Remember compact, attributed claims from selected story content in the background. A separately configured generative model proposes Memory Claims with exact supporting excerpts; Typesafe Jev judges their support and usefulness. Retrieve relevant saved Memories for each Generation and include them in a separate Memory Block with an editable Memory Allowance. Conversation history continues its ordinary truncation behavior.

The writer can inspect Memories and their sources, correct or remove them, retry failed processing, and explicitly remember existing history. A saved correction or removal makes that source's Memory Collection writer-maintained until the writer explicitly resets it. Story-wide Memories retain who said, witnessed, heard, or believes a claim. They support multi-character narration on a best-effort basis; they do not provide secrecy isolation from the writing model.

## User Stories

1. As a writer, I want past story events remembered after their Messages leave the prompt, so that I can continue a long story without repeatedly restating them.
2. As a writer, I want facts, relationships, promises, and changes remembered, so that later scenes can draw on earlier developments.
3. As a writer, I want Memories kept within their Conversation, so that unrelated stories do not influence one another.
4. As a writer, I want narrated events distinguished from spoken assertions, so that a character's accusation does not automatically become story truth.
5. As a writer, I want hearing, witnessing, and believing distinguished, so that character behavior can reflect the information actually established by the scene.
6. As a writer, I want unstated beliefs to remain unknown, so that silence is not treated as agreement or disbelief.
7. As a writer, I want a false Character Belief retained alongside the narrated event, so that misunderstandings can continue coherently.
8. As a writer, I want secrets to retain their knowledge attribution, so that the writing model has guidance about which characters may act on them.
9. As a writer, I want mentioned fictional people remembered without adding them to the Cast, so that memory does not force me to manage artificial Participants.
10. As a writer, I want ambiguous names and aliases preserved, so that the system does not silently merge different people.
11. As a writer, I want relevant temporal changes retained in context, so that a former location or relationship is not mistaken for an extraction error.
12. As a writer, I want authored Lore and learned Memory to remain distinct, so that automatic remembering does not rewrite shared Lorebooks.
13. As a writer, I want remembering to run automatically after eligible content is saved, so that I do not approve every candidate claim.
14. As a writer, I want Generation to proceed while new Memories are being extracted or indexed, so that background work does not prevent writing.
15. As a writer, I want only retained terminal generated Content processed, so that incomplete streaming output does not repeatedly create Memories.
16. As a writer, I want visible pending, running, complete, and failed processing states, so that I can distinguish unfinished remembering from an empty result.
17. As a writer, I want failed extraction and failed indexing retried separately, so that retrying an index does not regenerate my saved Memories.
18. As a writer, I want invalid or oversized extraction to fail visibly, so that I can understand why a source was not remembered.
19. As a writer, I want an explicit Remember existing history action, so that I choose when older selected content is processed.
20. As a writer, I want to cancel that catch-up work, so that I can stop it without cancelling ordinary remembering of new scenes.
21. As a writer, I want interrupted background work to recover after a restart, so that a server restart does not silently lose pending work.
22. As a writer, I want Memories to follow selected Variants, so that an unselected alternative does not establish facts in the current story.
23. As a writer, I want Sibling Generation to recall only from before its target Message, so that later events do not leak into an earlier rewrite.
24. As a writer, I want previewing an older Variant to leave authoritative Memory unchanged, so that browsing alternatives has no hidden effect on the story.
25. As a writer, I want editing a source to refresh only that source's automatic Memories, so that retained later Memories remain my choice.
26. As a writer, I want deleting a source to remove its own Memories while preserving later sources' Memories, so that deletion has a clear local effect.
27. As a writer, I want stale background results discarded, so that edited or deleted content cannot be restored into Memory by a late response.
28. As a writer, I want a separate Memory Block in my Prompt Preset, so that I can control its placement, role, and enablement.
29. As a writer, I want an editable Memory Allowance for each Chat, so that I can balance recalled material against older Conversation history.
30. As a writer, I want Lore and Memory admitted in preset order within their separate allowances, so that scarce prompt space follows my chosen recipe.
31. As a writer, I want claims admitted whole with attribution and negation intact, so that fitting a budget does not change their meaning.
32. As a writer, I want ordinary history truncation to continue, so that enabling Memory does not replace my history with summaries or retrieved passages.
33. As a writer, I want to add Memory explicitly to an existing preset, so that my saved recipe does not change unexpectedly.
34. As a writer, I want disabling Memory to stop its background work and recall while retaining saved collections, so that I can pause the feature without losing corrections.
35. As a writer, I want re-enabling Memory to resume current work without silently processing all intervening history, so that historical catch-up remains deliberate.
36. As a writer, I want to see when Memories are awaiting a compatible index, so that an empty block is not misreported as proof that nothing is relevant.
37. As a writer, I want recall service failures reported during prompt preparation, so that I can retry or deliberately disable Memory.
38. As a writer, I want a Memories panel with claim attribution and source navigation, so that I can understand what the system remembers.
39. As a writer, I want supporting excerpts and source-change information available in details, so that I can assess where a Memory came from.
40. As a writer, I want to edit saved claim text and attribution, so that future recall uses my correction without requiring model approval.
41. As a writer, I want to remove a Memory from its source, so that it stays removed from that source's automatic processing.
42. As a writer, I want a later scene to be able to remember the same fact again, so that removing an earlier Memory does not create a permanent story-wide prohibition.
43. As a writer, I want a clear indication that automatic updates are paused for a corrected source, so that I understand the scope of my edit.
44. As a writer, I want Reset and re-extract to explain that it discards my source-level overrides, so that resuming automatic processing is intentional.
45. As a writer, I want conflicting saved edits rejected against the current collection revision, so that one edit does not silently overwrite another.
46. As a writer, I want saved-memory correction distinguished from a one-attempt prompt edit, so that I can choose whether a change affects future recall or only the next Generation.
47. As a writer, I want prompt inspection to explain considered, omitted, and included Memories, so that I can understand the resulting Memory Block.
48. As a writer, I want the accepted inspected prompt sent unchanged, so that recall does not rerank or replace content after I approve it.
49. As a writer, I want changed Memory inputs to require Refresh before sending an inspected prompt, so that its explanation matches its captured inputs.
50. As a writer, I want historical Memory selection evidence retained with each Generated Variant, so that later corrections do not rewrite how old writing was produced.
51. As a writer, I want independent extraction settings and explicit service configuration, so that changing my writing model does not silently change remembering.
52. As a writer, I want credentials kept out of Chat content, Memory evidence, and settings reads, so that inspecting the feature does not reveal secrets.
53. As a writer, I want Memory inspection and correction usable on narrow screens with a clear return path, so that I can manage a story on mobile.
54. As a writer, I want the product to describe Memory as best effort, so that it does not imply perfect recall or guaranteed character-knowledge correctness.

## Implementation Decisions

### Domain semantics

- Memory is Conversation-local and consists of compact natural-language Memory Claims, attribution, descriptive person labels, and Memory Evidence. Retain narrated facts, witnessed events, spoken assertions, and stated beliefs without collapsing their meanings.
- Character Belief requires support in the Conversation, including explicit narration or an unambiguous expression of belief. Hearing a statement, silence, and missing evidence do not establish belief or disbelief. Preserve qualifications such as dreams, thoughts, quoted speech, uncertain narration, and explicit negation.
- Message authorship is separate from fictional presence and knowledge. Person labels need not be Participants, do not create Cast members, and are not a global entity registry. Preserve unresolved identity ambiguity.
- Express story time and occasional nested beliefs in attributed prose. Message timestamps are not in-world dates. Retain contextual changes and source-attributed conflicts without a temporal logic engine, recursive belief graph, or automatic truth-maintenance system.
- The writing model receives story-wide attributed Memories for multi-character narration. Ordinary history is not filtered by character viewpoint. Character-knowledge adherence is best effort, not a secrecy boundary from the model.
- Learned Memory does not modify authored Lore. Apparent conflicts preserve attribution rather than making either source universally authoritative.

### Ownership and integration

- Add one server-owned Memory module with a small public interface covering source scheduling, collection reads and corrections, readiness, recall capture/evaluation, and per-attempt evidence. It owns its SQLite tables, work lifecycle, and Memory invariants. HTTP routes and application workflows compose public domain interfaces; they do not become alternate Memory writers.
- Reuse the existing Conversation module for authoritative Message/Variant state, the existing Model Client for generative extraction, the configured embedding transport, existing secret handling, and the pure Generation Plan Compiler. Use the existing server application lifecycle to start and stop background processing. Do not add an external workflow service or vector database.
- Introduce a Memory Collection owned by one source Variant. Persist Conversation/Message identity, source-content hash, collection revision, automatic or writer-maintained ownership, work epochs/status/error, and extraction provenance. Retain empty collections so unprocessed, successfully empty, and writer-cleared sources remain distinguishable.
- Persist each Memory's claim, attribution, person labels, exact supporting excerpts and source identities, and owning collection. Preserve extraction judgment labels/probabilities as provenance without presenting probabilities as proof of truth or Character Belief strength.
- Persist background jobs and their captured source/context, Chat and source work epochs, collection revision, and optional catch-up origin. Exact table/column layout is an implementation choice. Use the repository's SQLite and Drizzle conventions.
- Store embedding data as derived data identified by exact rendered claim/attribution text and embedding endpoint/model, in a Memory cache namespace distinct from Lore embeddings. A changed rendering cannot reuse an old vector.
- Store per-attempt Memory selection evidence in server-owned Variant data, following the existing domain-owned provenance pattern. Retain it for the owning Generated Variant's lifetime, including retained interrupted output. Removing the owning Generated Variant removes that record. Source-memory deletion or correction cannot rewrite another Variant's historical record.
- Conversation workflows must schedule eligible saved human Content, selected terminal generated Content, selected alternatives, and direct edits. Resolve Memory work cancellation and ownership changes alongside authoritative source changes so crashes or late network completions cannot resurrect stale work. Shared preset edits and preset replacement/deletion must apply Memory enablement changes to every affected Chat.

### Source eligibility and narrative changes

- Eligible recall sources are selected Variants within the Generation attempt's history cutoff. Tail and Continuation Generation use their applicable selected history; Sibling Generation excludes its target and all later sources.
- Ordinary preview of an older alternative has no authoritative effect. Confirm Change and normal selection change eligibility. Stored Memories of unselected alternatives remain with their sources and can become eligible on reselection.
- Automatic extraction uses visible Content only. Exclude Reasoning Content, preset instructions, Participant definitions, and unselected alternatives. Out-of-character guidance is not a story event merely because it appears in a Human-authored Message.
- Queue eligible human Content after it is saved and eligible generated Content after a retained terminal outcome. Skip empty sources and provisional streaming output. Do not eagerly extract every unselected generated alternative.
- Directly editing an automatic source increments its source work epoch and makes its previous automatic collection stale and unavailable for current recall until refreshed. Queue replacement for the eligible selected source when Memory is enabled. No source-ID-only freshness check is sufficient because edits retain Variant identity.
- Earlier edits, selection changes, and deletions do not remove, re-extract, downgrade, or reinterpret later sources' collections or invalidate their queued/running work. Preserve their original captured interpretation context and exact excerpts without claiming revalidation against the new whole path.
- Deleting an owning Message/Variant deletes its collection, including manual edits. Deleting the Conversation removes its Memory state and work. Deleting an earlier context source leaves later collections and their retained evidence intact.

### Extraction and judgment

1. Capture one selected source Variant's complete Content and at most four immediately preceding selected Messages for reference resolution. Capture source/context identities and text when queuing. Prior context may explain a person or situation, but each new candidate must have supporting evidence from its owning source.
2. At execution start, capture the chosen extraction Connection Profile, model, and nonsecret processing settings. Resolve credentials through existing secret handling when calls start. Run extraction through the provider-neutral Model Client without creating a Conversation Message or Variant.
3. Request one JSON object containing a candidates array. Each record has nonblank claim text, attribution, person labels, and exact excerpts referencing only the captured source/context list. Empty candidates are a valid complete result.
4. Validate the entire response shape, bounds, source references, and exact excerpt membership in application code. Require at least one excerpt from the owning source for each candidate. A non-successful or truncated response, malformed JSON, invalid record, unknown reference, or mismatched excerpt fails extraction atomically. The current Model Client provides prompt-based JSON generation with validation, not a provider-enforced structured-output guarantee.
5. Suppress exact duplicate candidates within the new batch. Send validated candidates and relevant evidence to Jev using independent typed questions: a support Choice of supported / contradicted / not_established, and a usefulness Choice of retain / omit. Include attribution and explicit candidate identity in the state and question instructions. A question cannot depend on another question's answer.
6. Admit only supported + retain. Combine answers in code, without a calibrated confidence threshold. Require a complete, valid judgment result; failure in a required batch prevents partial collection publication. Jev judges supplied claims and does not generate Memory prose, discover unknown claims, merge people, or retire old Memories.
7. Publish the admitted collection and extraction evidence atomically after the freshness checks below. Index it separately; stored claims become ready for recall only with a compatible current index. An indexing failure preserves saved claims and does not rerun extraction.

Initial resource bounds are implementation defaults, not recall, latency, or cost promises:

| Operation | Bound or default | Overflow behavior |
| --- | --- | --- |
| Preceding extraction context | At most 4 Messages and 2,048 estimated tokens | Drop oldest context first; preserve the complete owning source |
| Extraction request context | 16,384 estimated tokens; editable independently of writing settings | Account for instructions, evidence, output reserve, and safety; fail visibly if the source cannot fit |
| Extraction output reserve | 2,048 estimated tokens; editable independently | A truncated response fails extraction |
| Extraction safety allowance | 500 estimated tokens | Include in request budgeting with the shared estimator |
| Owning source Content | 12,000 estimated tokens maximum | Visible source-too-large failure; no automatic chunking or summary |
| Collected extraction response | 64 KiB maximum | Fail rather than accept a partial response |
| Candidates per source | At most 16 | Reject an invalid array |
| Rendered claim and attribution | At most 1,024 characters per candidate | Reject invalid extraction output |
| Evidence per candidate | At most 3 excerpts, each at most 1,024 characters | Reject invalid extraction output |
| Extraction duration | 60-second deadline | Visible failed source work |
| Background execution | At most 2 concurrent jobs across extraction and indexing | Keep remaining work pending |

Use the shared Token estimator. Drop bounded prior context as needed before rejecting an otherwise admissible source; never silently truncate the owning source. Source/context packing and the final request must both respect their limits.

### Durable work, cancellation, and recovery

- Persist pending, running, complete, and failed source work. Claim jobs atomically and perform network I/O outside database transactions. Prioritize newly selected/edited sources over historical catch-up. Use one process-owned worker with the shared extraction/indexing concurrency bound.
- At queuing, capture the source-content hash, source work epoch, Chat work epoch, collection revision, source text, and bounded prior context. At execution, capture processing settings and the chosen profile/model. Changes before execution affect queued jobs; running jobs retain their captured nonsecret configuration. Completed collections are not automatically regenerated when extraction settings change.
- In the final publication transaction, require that the source still exists, its captured content hash and source epoch still match, its collection revision has not been superseded, the Chat epoch still matches, and the active preset still has an enabled Memory Block. Automatic extraction must not publish into a writer-maintained collection. Earlier unrelated history changes are deliberately excluded from this check.
- Disabling/removing the active Memory Block, or switching to a preset without it, advances the Chat work epoch, cancels pending/running work for that Chat, and rejects late publication. Re-enabling cannot make an old cancelled completion valid again. Keep published collections and derived cache data.
- Selecting an unprocessed alternative while enabled queues that source. Work already running for an unchanged source that becomes unselected may finish and remain stored with that alternative; completion order never determines current eligibility.
- Retry failed extraction with a new source epoch. Retry failed indexing using saved current claim text. No automatic model-response retry, format repair, alternate provider, or unjudged-candidate publication is allowed.
- After restart, resume pending work and requeue interrupted running work if still eligible. Discard stale, removed, cancelled, or automatically processed work whose collection has become writer-maintained. Remote calls can occur more than once across crashes; only a current local result may publish.
- Remember existing history captures the Selected narrative path at invocation and persists source jobs. Skip already current and writer-maintained collections; skip a pending catch-up source if it is no longer selected when its job starts. Process each source with its bounded captured prior context.
- Identify the catch-up run on its jobs. Cancellation removes that run's pending jobs and advances source epochs for its running member jobs, preventing publication. It does not cancel ordinary live-source jobs. Source/work deduplication must preserve this cancellation scope.
- Re-enabling Memory resumes indexing saved collections and queues the current selected tail source if unprocessed. It does not silently extract all history written while disabled. A zero Memory Allowance is a prompt-space setting and does not disable collection work or discard ownership.

### Corrections and inspection

- Provide a Memories secondary panel with selected-path claims, attribution, source navigation, and processing state. Details show exact excerpts, automatic or writer-maintained ownership, and whether the owning source has changed. On narrow screens use a full-screen layer with a clear back path and preserved story position. Follow the established design system and prefer existing Radix/Shadcn components.
- Edit changes saved claim text/attribution used for future recall. Remove deletes a saved Memory from that source. Both are revision-checked atomic operations with a conflict result exposing current authoritative state; neither rewrites the Conversation, Lore, other sources, or historical Generation evidence.
- The first edit or removal makes the entire source collection writer-maintained. Increment its revision and prevent queued/running automatic extraction from replacing it, adding claims, or recreating removals. Persist the ownership even when the collection becomes empty. Details explain that automatic updates are paused for this source.
- Treat the writer's correction as authoritative. Do not ask Jev to approve it again; re-index the rendered text. Preserve the original extraction evidence as provenance and identify the manual edit instead of implying that its old excerpt proves the corrected claim. Corrected Memories still participate in ordinary relevance selection and budgeting.
- Editing the owning source afterward preserves a writer-maintained collection and marks its evidence source-changed. It remains subject to ordinary selected-path eligibility; automatic source refresh never overrides it.
- Reset and re-extract explicitly clears that source's manual collection and removal suppression, increments its revision and epoch, and queues its current source for automatic processing. State this destructive-to-overrides effect in the action. It is the only transition back from writer-maintained to automatic ownership.
- Removal is local to the source. Another later scene may independently establish and remember the same fact. There is no semantic blacklist or paraphrase-matching suppression across the Conversation.
- Saved-memory edits affect future recall. Editing the Memory Block in Inspect Prompts affects only that accepted Generation Plan. Clearly distinguish these actions in product copy.

### Index readiness

- Reuse the application's embedding endpoint/model, credentials, and configured deadline. Index compact claim text together with attribution under the distinct Memory namespace. Memory semantic shortlisting does not inherit Lore's trigger semantics or matching threshold.
- Readiness requires the exact current rendered text and current embedding endpoint/model. An endpoint/model change immediately excludes incompatible vectors from fresh recall and queues index-only rebuilds for saved Memories in enabled Chats. Re-enabling a Chat resumes any required indexing.
- Expose pending and failed indexing counts during initial indexing, rebuilds, partial rebuilds, and recovery. Current compatible ready records remain usable. If none are ready, produce an empty block with explicit pending/rebuilding status; do not label that as a successful no-match judgment.
- Never compare incompatible vectors or use stale embeddings as substitute recall. Index-only work cannot rewrite claims, reverse manual ownership, or republish deleted/changed records. Publication validates its captured record text/configuration and applicable cancellation state.
- Background extraction/indexing pending or failed does not block writing with currently ready records. A required recall request that actually fails is a prompt-preparation error, as specified below.

### Recall and bounded Typesafe requests

- Capture applicable selected sources, collection revisions/status, ready records and index identity, the recent scene, and relevant settings once before recall I/O. Include pending human Send text in the scene. Exclude Reasoning Content, definitions, and preset instructions, and honor Sibling Generation's cutoff.
- Scan the latest four applicable Messages with a 4,000-estimated-token cap. Drop oldest scan Messages first. If a sole remaining Message exceeds the cap, use its trailing bounded text and record scan truncation in inspection. This trimming affects only the recall scene, not the real history block.
- From ready eligible records, take up to 48 nearest semantic matches and up to 16 most recent records, deduplicated by identity. Compare cached compatible vectors in application code. Keep the shortlist bounded as the Conversation grows.
- Ask Jev two independent questions per candidate: retain/omit for useful context beyond the captured scene, and a Score with ordered relevance levels irrelevant / incidental / useful / central. Retain is the admission gate. Sort retained records by descending returned Score, then source recency, then stable identity. Include candidate identity explicitly in the question instructions.
- Exact repeated rendered claims may be suppressed in the final recall candidates without deleting stored Memories. Do not perform destructive cross-history semantic deduplication or contradiction cleanup.
- Initial Jev integration uses the tested pinned model jev-1.13.0 and the documented System One HTTP operation. Keep its typed judgment transport inside the Memory boundary, reusing the repository's bounded-response, cancellation, timeout, and secret-handling mechanisms. Do not force typed judgments through the generative Model Client interface.
- Bound every Jev request to 16,000 estimated state tokens, 48,000 estimated total request tokens, and 128 KiB serialized bytes. Also respect the documented 32k state-plus-longest-question and 64k total limits. Estimates remain approximate; provider context rejection is a visible error.
- Drop lowest-priority recall shortlist candidates until the request fits, preserving deterministic shortlist priority and omission evidence. For extraction judgments, split candidates into bounded batches while repeating required source evidence. If required evidence alone cannot fit, fail visibly rather than crop it.
- Use a 15-second deadline and 256 KiB response bound for Typesafe requests. Reject malformed, missing, or incomplete required answers. Do not automatically retry or repair model responses. Reuse the configured embedding deadline.
- If no eligible records are ready, no recall inference is required and the Memory Block is empty with accurate readiness status. If required embedding-query or Jev recall calls for the ready set fail, stop new prompt preparation with a visible error and offer Retry or deliberate Memory disablement. There is no stale-vector, unranked, keyword-only, or alternate-provider recall fallback.

### Prompt Preset and token allocation

- Add Memory as a Referenced Prompt Block with at most one occurrence per preset, counting disabled occurrences. Its role and position are editable; the initial role is system. Validate this rule in editing and native preset interchange. Extend native export/import to preserve the block.
- A freshly created Default recipe places Lore, then Memory, immediately before history. Existing saved/imported recipes gain Memory only through an explicit Add Memory Block action. Preserve their authored order and do not infer an unapproved SillyTavern memory-placeholder mapping.
- A Chat has Memory enabled exactly when its active Prompt Preset contains an enabled Memory Block. Explain absent/disabled status and expose applicable add/enable actions. A disabled block issues no Memory recall calls and stops background Memory work as described above.
- Persist a Chat-owned Memory Allowance, initially 2,048 estimated tokens, editable as a non-negative whole number including zero. It is an independent ceiling, not a guaranteed reservation. Zero admits no Memory text while preserving collection processing and ownership.
- Extend the existing pure Generation Plan Compiler with already captured and judged Memory admission candidates and selection evidence. All retrieval/model I/O occurs before compilation; the compiler remains independent of SQLite, HTTP, and credentials.
- Reserve output budget, safety allowance, fixed preset content, and existing protected history first. Protect the latest applicable human entry, or the preceding model entry for assistant-prefill Continuation, following current compiler behavior. Keep the explicit failure when required context cannot fit.
- Admit dynamic Lore and Memory blocks in their Prompt Preset order against the remaining context, each within its own allowance. Preserve existing Lore priority rules. Preset order determines which optional block gets first claim when both allowances cannot fit.
- Admit whole Memories in their deterministic recall order. Skip a record that does not fit and continue to smaller candidates; never clip attribution or negation. Estimate the actual compiled content, including rendering overhead, and perform the existing final-plan budget check.
- Older history uses remaining space and follows normal oldest-first whole-message truncation. Memory does not summarize, replace, or restore history passages. Do not rerun recall or Lore matching after history trimming.
- Render compact claim text and attribution in the Memory Block. Exact excerpts, source details, and classifier outputs remain inspectable evidence rather than default prompt content.

### Captured prompts and permanent evidence

- Include Memory source identities, collection revisions/state, index readiness/configuration, relevant nonsecret settings, scene, preset state, and allowance in stable prompt-preparation inputs. Rechecking an inspected prompt compares captured inputs and does not rerun stochastic Jev judgments.
- Changed relevant Memory inputs require explicit Refresh. Sending an accepted inspected plan sends its final Memory Block without reranking, re-extraction, macro re-expansion, silent trimming, or reassembly. Validate invalid/stale/oversized plans by rejection, not replacement.
- Active Generations keep the Memory context captured when accepted. Background publication cannot alter an already accepted model input.
- Retain per-attempt evidence for the considered shortlist, semantic/recency basis, Jev decisions and scores, request-packing omissions, readiness and scan-truncation status, source identities and excerpts, relevant nonsecret settings, and allowance/context admission decisions. Do not copy the whole Memory database into every attempt.
- Preserve original automatic Memory text and the final block text when the writer edits an inspected Memory Block; mark it manually edited. Do not infer source identities from arbitrary replacement text or claim that the automatic selection text was sent unchanged.
- Historical evidence stays readable after live Memory correction/removal, source edits/deletion, and transient prompt-inspection expiry, for as long as its own Generated Variant remains. Expose it through the existing Variant-details/inspection surfaces using Memory-owned contracts rather than Lore Activation Records.

### Settings and public actions

- Application Memory settings explicitly select the extraction Connection Profile and model, extraction context/output settings, and Typesafe credential/model, initially pinned to jev-1.13.0. Embedding settings remain application-owned and shared with the existing embedding service.
- Use standard extraction model defaults with grounded compact-claim instructions. Do not inherit Chat sampling settings, Prompt Presets, tools, arbitrary Request Overrides, or the selected writing model into extraction.
- Missing/deleted extraction profiles and unconfigured required services produce explicit configuration failures. Never select a replacement profile or provider automatically. Settings changes affect jobs that have not begun and explicit retries; running work retains its captured nonsecret configuration and completed Memory is not automatically regenerated.
- Keep credentials in existing encrypted secret handling, with write-only client operations and configuration-presence indicators. Resolve them server-side for outbound calls. Exclude plaintext secrets from collections, jobs, evidence, fingerprints, model-visible source content, error payloads, and settings reads. Research/probe credentials are not application configuration.
- Expose domain actions for collection/status reads, revision-checked edit/remove, Reset and re-extract source, retry extraction/indexing, start/cancel selected-history catch-up, Memory Allowance changes, application settings and write-only credentials, and per-attempt evidence reads. Recall capture/evaluation is a server application operation. Work epochs and database job rows remain private implementation details.
- Extend existing shared contracts and client command handling for validation, authoritative conflict responses, failed processing, and readiness states. Keep browser state responsible for presentation; the server owns background progress, cancellation, and publication.
- Follow current repository migration conventions. No backwards-compatibility layer or obsolete implementation path is required. If implementation adds seed data, its matching teardown must share seed arrays and remove only those exact seeded rows with dependants first.

## Testing Decisions

- **Primary seam: public server behavior.** Exercise the existing HTTP/application composition with real SQLite, the real Conversation and Memory modules, and controlled external generative, Typesafe, and embedding responses. Drive source edits, selections, corrections, catch-up, settings, preview, Generation, and details through production public operations. Observe saved collections/status, conflict/error results, retained evidence, and actual outbound writing prompts. Control external response completion to exercise races; do not mock Memory internals or assert table layout and private call sequences.
- **Focused existing seam: the pure Generation Plan Compiler.** Use deterministic captured inputs and the existing Token estimator injection to test independent allowances, preset-order competition, whole-claim admission, protected human/prefill history, and final context failure. Avoid duplicating these budget combinations through every HTTP scenario.
- For durable worker recovery and cancellation that require process lifecycle control, exercise the production Memory module/application lifecycle with a temporary SQLite database and controlled network completion. Reopen persisted state to verify visible recovery results. Keep this at the same public service boundary; do not create a framework of worker-internal test hooks.
- Prior art includes the existing Prompt Plan inspection route tests that capture outbound model requests, permanent Lore Activation Record contract tests, revision-checked Lorebook and embedding-settings contract tests, Generation Coordinator lifecycle tests, and Generation Plan Compiler Lore admission/protected-history tests. Reuse their database and transport composition patterns while asserting Memory-specific observable outcomes.
- Cover supported/retain admission, an empty successful collection, unknown or mismatched source evidence, invalid/truncated extraction, incomplete Jev answers, resource limits, and index-only failures. Scripted provider answers verify application policy and request contracts; they do not establish model accuracy.
- Cover selected-path eligibility, Sibling cutoffs, no extraction from provisional or Reasoning Content, pending human scene inclusion, automatic-source edits, alternative selection, source deletion, and preservation of later collections and pending later jobs after earlier unrelated edits.
- Cover manual correction/removal winning over late extraction, persistence of empty writer-maintained collections, source edits preserving manual ownership, source-local recurrence from later scenes, reset semantics, and stale revision rejection.
- Cover disabling during work followed by re-enable, catch-up cancellation versus ordinary live work, process restart, settings changes before versus after execution, and at most two simultaneous background jobs. Assert externally visible effects such as no late publication and correct captured model settings rather than internal epoch values.
- Cover current-text/index identity, embedding configuration changes and partial rebuild readiness, empty-ready-set preparation, visible recall failure for a ready set, and absence of disabled-feature external calls. Use failing transport fixtures to verify that no alternate retrieval or provider is silently used.
- Cover accepted inspected Memory text reaching the model unchanged without another recall call, Refresh on changed Memory inputs, active-attempt isolation, one-attempt edits versus saved corrections, and historical evidence surviving later live changes until its owning Variant is deleted.
- Cover Memory settings' write-only credentials and ordinary configuration failures through the settings/service contracts. Test the new typed judgment wire behavior at the external transport boundary only where needed for malformed responses, byte/deadline bounds, and error handling.
- No UI tests. No tests that merely repeat declarations, enforce file/module arrangement, or lock down a refactor's architecture. During implementation, check the Memories panel and narrow-screen interaction manually against the design direction.
- No live paid model calls, quality benchmark, labeled evaluation corpus, recall percentage, latency/cost target, or confidence-calibration gate is required. Three earlier Jev probes illustrate limited typed judgments and are not an acceptance suite. Automated tests establish deterministic application behavior under controlled service results.

## Out of Scope

- Cross-Conversation Memory, shared personal preferences, or transferring learned knowledge between unrelated stories.
- Redesigning Lorebooks, rewriting story text automatically, source-passage substitution, Memory-driven history compression, or a general Message revision store.
- Downstream retcon repair, whole-history consistency scans, destructive cross-history merging, automatic contradiction resolution, global person identity graphs, recursive belief graphs, or an in-world calendar engine.
- Perfect/exhaustive recall, guaranteed truth or secrecy isolation from the writing model, model-quality measurement programs, benchmark/adoption gates, or numerical latency/cost/recall acceptance targets.
- Source chunking/summarization for oversized extraction, model-response repair/retry loops, stale-vector or alternate-retrieval substitutes, and automatic replacement providers/profiles.
- Conversation-wide semantic forgetting, pinning, a standalone manual-memory library, or a mandatory approval inbox for automatic memories.
- An external queue service, workflow framework, graph/vector database, compatibility layers, or an exactly-once remote-call mechanism.
- Automatic insertion of Memory into existing recipes, automatic extraction of all historical Messages on enablement, and re-extraction of completed collections merely because a model or setting changes.
- UI tests, new paid inference probes, implementation tickets, application implementation, or deployment as part of this spec-writing task. The feature described here is the scope for subsequent implementation planning.

## Further Notes

This spec consolidates the closed [Memory wayfinding map, ditzytavern#1](https://tan-server.taild926e3.ts.net:8444/projects/ditzytavern/issues/1). Read resolved decisions in the map's index order; final resolution comments supersede earlier working proposals. In particular, the final clarification in #10 governs cancellation publication checks and execution-time settings capture. Earlier research suggestions for measurement were superseded by #4.

| Decision | Source |
| --- | --- |
| Documented Typesafe capabilities and limits | [#2: Assess Typesafe Jev](https://tan-server.taild926e3.ts.net:8444/projects/ditzytavern/issues/2) |
| Evidence and character-perspective research | [#3: Investigate grounded story memory](https://tan-server.taild926e3.ts.net:8444/projects/ditzytavern/issues/3) |
| Best-effort expectations; no measurement gate | [#4: Set memory expectations](https://tan-server.taild926e3.ts.net:8444/projects/ditzytavern/issues/4) |
| Claims, attribution, belief, identity, and limited live probes | [#5: Define memory claims](https://tan-server.taild926e3.ts.net:8444/projects/ditzytavern/issues/5) |
| Source ownership and preservation of later Memories | [#6: Narrative-path changes](https://tan-server.taild926e3.ts.net:8444/projects/ditzytavern/issues/6) |
| Generative extraction followed by Jev judgments | [#7: Extraction and Typesafe's role](https://tan-server.taild926e3.ts.net:8444/projects/ditzytavern/issues/7) |
| Story-wide recall, prompt placement, budgets, and captured evidence | [#8: Recall and prompt budget](https://tan-server.taild926e3.ts.net:8444/projects/ditzytavern/issues/8) |
| Inspection, source-level manual ownership, and local removal | [#9: Inspection and correction](https://tan-server.taild926e3.ts.net:8444/projects/ditzytavern/issues/9) |
| Resource bounds, work lifecycle, indexing, settings, and final clarifications | [#10: Bounded processing](https://tan-server.taild926e3.ts.net:8444/projects/ditzytavern/issues/10) |

The existing architectural decisions remain applicable: the deep Conversation module and domain-owned transactions; one provider-neutral Model Client; separate authorship and fictional identity; encrypted application secrets; shared Prompt Presets; the pure Generation Plan Compiler; exact accepted inspected prompts; and Variant-lifetime provenance. Memory extends the single-block Lore precedent with its own single referenced block and extends dynamic budget admission to follow preset order. It does not adopt Lore's embedding-failure fallback for Memory recall.

Research and probe artifacts are retained on the local research branches linked from #2, #3, and #5. The recorded commits are c2e68fd9017d611251d55d6f17b2189ba759813d for Typesafe research, c4b00fc8ce88ca770b2a26b4f541a88e8087966b for grounded-memory research, and 2d2ced735da2609444ec8a536d6391c53567c224 for the three limited Jev probes. The research recommendations do not override later product decisions.

Split this spec into implementation tickets with native blocker relations. The closed wayfinding map remains a decision record; this spec is the implementation parent.
