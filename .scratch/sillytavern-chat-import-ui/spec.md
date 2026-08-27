# SillyTavern Chat Import UI

Status: ready-for-agent

Blocked by: 01 — Character System dependency gate

## Problem Statement

As a DitzyTavern user, I can import a SillyTavern Chat only through a developer database command. There is no supported application flow for choosing an export, validating it, deciding which Conversation-local Participants authored its Messages, reviewing the consequences, or opening the result as a normal Chat.

The implemented importer deliberately preserved source author names without turning them into native identity. That was correct while DitzyTavern lacked Participants and immutable Author Stamps, but a user-facing import cannot fabricate Writer, Character, or role assignments from SillyTavern remnants. It must let the user decide how captured names are split, merged, and represented in the Roster. This work therefore depends on the Character System supplying Actor Profiles, Conversation-local Participants, Author Stamps, and the public Profile Library and Conversation seams described by the accepted ADRs.

The current importer also preserves a canonical parsed archive rather than the exact original bytes. A user-facing import needs an exact downloadable copy of the chosen file without making that artifact part of ordinary Chat reads or a dependency of normal Chat behavior. Imported Chats must graduate immediately into ordinary DitzyTavern Chats: their Messages and Variants use native persistence and capabilities, while immutable import provenance remains available only through deliberate inspection.

## Solution

Add an **Import Chat** action to the Chats primary panel. It opens a nested, multi-step flow that uploads one file once, validates the exact staged bytes, resolves source author groups into native Participants, presents a complete final review, and commits the exact previewed source through an idempotent operation.

The resolver starts with one group per resolved (trimmed) captured author string through the shared Import Projection grouping primitive. Whitespace variants and every blank captured name collapse into one group; case and Unicode stay distinct. Name-only matching ranks existing Characters, but never removes the user's final authority. The user can merge groups, split a group by moving whole Messages, accept a pre-filled but unconfirmed existing Character, create a new Character, or keep a Participant local to the Chat. No Message may be skipped. Blank captured names require an explicit usable Participant name. SillyTavern role flags, including `is_user`, have no import meaning. The exact raw captured values stay untouched in preserved import data regardless of grouping.

The Character System remains the prerequisite and owner of native identity. Selecting an existing Character forks its Actor Profile into an independent Conversation-local Participant. Creating a Character creates the Participant and a separate Actor Profile in the same database commit. A Chat-only Participant is already complete and valid; it is not an unresolved or degraded identity. Profiles and Participants do not retain a live synchronization or identity link.

Preserve both the existing canonical parsed archive and an exact copy of the original file bytes. Store exact bytes as a separately managed filesystem artifact referenced by generic Conversation artifact metadata. The artifact is downloadable on demand but excluded from normal Chat reads. Artifact disappearance is treated as cleanup and never impairs the native Conversation.

After commit, open the imported Chat immediately. It has no imported-only capability mode, badge, category, or read-only policy. Native Messages, Participants, Author Stamps, and Variants behave exactly like those created inside DitzyTavern. Normal edits and Variant selection mutate the working Conversation while both preserved source representations remain immutable.

## User Stories

1. As a DitzyTavern user, I want an Import Chat action in the Chats panel, so that importing is discoverable where Chats are managed.
2. As a DitzyTavern user, I want the import flow to remain inside the Chats panel, so that it follows the application's existing panel hierarchy.
3. As a narrow-screen user, I want the same flow to use the panel's full-screen responsive treatment, so that import remains usable without a separate mobile design.
4. As a DitzyTavern user, I want to choose one SillyTavern JSONL export per flow, so that resolution and errors remain attributable to one Chat.
5. As a DitzyTavern user, I want files with nonstandard extensions accepted when their content is valid SillyTavern JSONL, so that filename conventions do not prevent recovery.
6. As a DitzyTavern user, I want the selected file uploaded only once, so that final import does not depend on reopening or rereading my original file.
7. As a DitzyTavern user, I want validation to finish before identity resolution begins, so that I do not spend time resolving an invalid export.
8. As a DitzyTavern user, I want malformed JSON and structural defects reported contextually, so that I can understand why the file cannot proceed.
9. As a DitzyTavern user, I want recoverable failures to preserve my preview and resolution work, so that retrying does not repeat completed decisions.
10. As a DitzyTavern user, I want a warning before abandoning an unfinished import, so that I do not accidentally discard resolution work.
11. As a DitzyTavern user, I accept reselecting the file after a server restart, so that DitzyTavern does not need durable import drafts.
12. As a DitzyTavern user, I want the filename-derived Chat title pre-filled and editable, so that I receive a useful default without being constrained by it.
13. As a DitzyTavern user, I want one initial author group per resolved captured name, with whitespace variants and blank names merged, so that the importer keeps source identity recognizable without repeating confirmations.
14. As a DitzyTavern user, I want case and whitespace variants to remain separate initially, so that similarity is not mistaken for identity.
15. As a DitzyTavern user, I want name-only Character suggestions, so that SillyTavern-specific role and header metadata cannot bias native identity.
16. As a DitzyTavern user, I want exact, case-insensitive, and fuzzy Character-name matches ranked in that order, so that likely choices are easy to find.
17. As a DitzyTavern user, I want the strongest match pre-filled but unconfirmed, so that suggestions save effort without making decisions for me.
18. As a DitzyTavern user, I want every Character association explicitly confirmed, so that I retain final authority over identity.
19. As a DitzyTavern user, I want to merge several captured-name groups into one Participant, so that spelling variants or aliases can share one native identity.
20. As a DitzyTavern user, I want merged Messages to retain their original values in preserved source data, so that resolution does not rewrite the export.
21. As a DitzyTavern user, I want to inspect the Messages attributed to one captured name, so that I can recognize when the same name represented different identities.
22. As a DitzyTavern user, I want to split selected Messages into another Participant group, so that one captured name need not force one identity.
23. As a DitzyTavern user, I want all of a Message's Variants to move with that Message during a split, so that alternative content never acquires conflicting authorship.
24. As a DitzyTavern user, I want merge and split actions reversible before commit, so that I can refine the Roster safely.
25. As a DitzyTavern user, I accept reimporting after a committed authorship mistake, so that historical Author Stamp assignments remain immutable.
26. As a DitzyTavern user, I want to fork an existing Character into a Conversation-local Participant, so that the imported Chat can use an existing Profile without a live dependency on it.
27. As a DitzyTavern user, I want a Participant forked from an existing Character to use that Profile's current name, so that the native Chat reflects the resolved identity.
28. As a DitzyTavern user, I want to create a minimal new Character during resolution, so that a new reusable identity can be established without leaving the flow.
29. As a DitzyTavern user, I want new Profiles and the Conversation committed together in SQLite, so that a database failure leaves neither partial Characters nor a partial Chat.
30. As a DitzyTavern user, I want duplicate Character names allowed after visible warning, so that names never become identity keys.
31. As a DitzyTavern user, I want to keep an author as a Chat-only Participant, so that every valid Chat identity does not have to enter the global Library.
32. As a DitzyTavern user, I want blank captured names surfaced explicitly and given an editable `Unknown imported author` default, so that native authorship is usable without hiding the source defect.
33. As a DitzyTavern user, I want every retained Message assigned to a Participant, so that import never skips history to avoid an identity decision.
34. As a DitzyTavern user, I want every imported Participant represented in the Roster and Cast, so that authorship and visible participation remain consistent.
35. As a DitzyTavern user, I want `Writer` treated like an ordinary captured name, so that DitzyTavern does not infer a special identity from legacy vocabulary.
36. As a DitzyTavern user, I want SillyTavern's `is_user` field ignored completely, so that a source-format remnant cannot become native Control or identity.
37. As a DitzyTavern user, I want native Author Stamps to capture the resolved Participant name at commit, so that the graduated Chat uses its resolved native authorship.
38. As a DitzyTavern user, I want the original captured spelling retained in import provenance, so that source truth remains recoverable even when native authorship uses another name.
39. As a DitzyTavern user, I want a final review of the title, source identity, counts, Participants, resolution outcomes, warnings, and duplicates, so that I understand the complete operation before committing it.
40. As a DitzyTavern user, I want an exact-byte duplicate distinguished from a related source with matching declared integrity, so that warnings describe their actual confidence.
41. As a DitzyTavern user, I want an exact duplicate to require explicit Import another copy confirmation, so that accidental repetition is not silent.
42. As a DitzyTavern user, I want intentional duplicate imports to remain allowed, so that I can create independent native Chat copies.
43. As a DitzyTavern user, I want a lost response or retry to return the same committed result, so that transport failure cannot create an accidental duplicate.
44. As a DitzyTavern user, I want no arbitrary application size limit, so that I decide which valid local exports are worth attempting.
45. As a DitzyTavern user, I want named phases while DitzyTavern uploads, validates, prepares, and commits, so that long-running work remains understandable without fabricated percentages.
46. As a DitzyTavern user, I want cancellation until the final commit begins, so that I can stop work before the authoritative operation.
47. As a DitzyTavern user, I want the exact previewed bytes to be the bytes that are committed and preserved, so that the review cannot describe one file while another is imported.
48. As a DitzyTavern user, I want failure to preserve the exact artifact to abort before Chat creation, so that a successful import always satisfies its preservation promise initially.
49. As a DitzyTavern user, I want the original bytes preserved without normalization, so that BOMs, line endings, whitespace, escape spelling, and trailing bytes survive exactly.
50. As a DitzyTavern user, I want the canonical parsed archive retained alongside the exact bytes, so that structured recovery does not depend on reparsing the opaque artifact.
51. As a DitzyTavern user, I want Download preserved source to return the exact stored bytes with the original leaf filename, so that I can recover the imported artifact faithfully.
52. As a DitzyTavern user, I want missing exact-source storage reported as cleaned up, so that provenance loss does not make the working Chat look corrupt.
53. As a DitzyTavern user, I want an imported Chat to open immediately after success, so that I can inspect the result without finding it manually.
54. As a DitzyTavern user, I want a compact success receipt, so that I can confirm what was created.
55. As a DitzyTavern user, I want persistent Import Details available through Chat information, so that warnings and source identity remain inspectable later.
56. As a DitzyTavern user, I do not want a permanent Imported badge or category, so that origin does not become a capability class.
57. As a DitzyTavern user, I want imported Chats to receive every capability normal Chats receive, so that import is an ingestion event rather than a lasting mode.
58. As a DitzyTavern user, I want native Messages loaded in pages, so that very large graduated Chats remain usable.
59. As a DitzyTavern user, I want heavy provenance and preserved archives loaded only on demand, so that normal reading and commands stay lightweight.
60. As a DitzyTavern user, I want the source-selected Swipe to initialize the native selected Variant, so that the first native view matches the export.
61. As a DitzyTavern user, I want normal swipe navigation to persist the native selected Variant, so that imported and application-created Messages share one interaction model.
62. As a DitzyTavern user, I want empty and duplicate Variants preserved as distinct choices, so that unusual source state remains native and navigable.
63. As a DitzyTavern user, I want empty content represented by a presentation-only placeholder, so that an exact empty Variant is visible without being rewritten.
64. As a DitzyTavern user, I want later normal edits to affect only native Conversation data, so that the preserved source remains immutable evidence of what was imported.
65. As a DitzyTavern maintainer, I want this feature blocked until the Character System is implemented, so that import cannot create an alternate Participant, Profile, or authorship model.

## Implementation Decisions

- Publish this as a new UI effort rather than reopening the completed developer-import effort. The earlier specification and resolved issues remain historical evidence of the backend importer that this feature extends.
- Keep the entire effort blocked behind a Character System dependency gate. The prerequisite must supply Conversation-local Participants and Roster membership, immutable inline Author Stamps, Actor Profile Library list/read/create seams, Profile-to-Participant forking, creation of a new Profile while resolving a Participant, and Character-name lookup.
- Treat user-facing **Character** as the product term for an Actor Profile. Preserve the accepted domain distinction: an Actor Profile is an optional reusable source; a Participant is an independent Conversation-local identity; an Author Stamp contains the stable Participant identifier and name captured when the Message is created.
- Preserve fork/copy semantics. Adding from an existing Profile creates a new independent Participant Prompt fork. Creating a Character from a Participant copies the Participant name and Participant Prompt into a new Profile and Master Prompt. No live identity, synchronization, reset, merge, or rebase link is introduced.
- Add one deep SillyTavern Import application module as the primary public seam for staged upload, preview, resolution validation, idempotent commit, discard, receipt, and exact-source access. Keep source-format vocabulary inside this module.
- The import module orchestrates only public Conversation and Profile Library capabilities. It does not write Participant, Profile, Message, Variant, Roster, or Author Stamp tables directly.
- Keep typed HTTP routes thin over the import module. Keep the client behind one replaceable typed import-client boundary rather than distributing transport calls across view components.
- Add **Import Chat** as a first-order action in the Chats primary panel. Render the flow as nested panel content with Back and Cancel controls; reuse the panel's full-screen narrow-layout behavior.
- Model the flow as choose file, validate and preview, resolve Participants, final review, commit, then success. Do not combine invalid-source handling with the resolution step.
- Accept one file per flow. Prefer `.jsonl` in the picker but use content validation as authority and accept other extensions.
- Stream the selected bytes into managed staging storage once. Do not send a browser filesystem path and do not reopen the original file for final commit.
- Bind the staged token to byte length and SHA-256. Commit only the exact staged object that produced the preview. Consume a token at most once while retaining its successful result for idempotent retry.
- Keep unfinished staging session-bound. Explicit cancellation discards the temporary upload after confirmation. A server restart expires the flow; no durable draft or resume mechanism is added.
- Set no application-level source-size limit. Stream upload and download rather than requiring the HTTP boundary to buffer the complete artifact. Report resource and storage failures clearly.
- Preserve the existing strict UTF-8 and structural validation rules. The complete source must validate before any native or global domain record is created.
- Extend preview output with editable Chat title, source filename, SHA-256, declared integrity when present, Message and Variant counts, warnings, resolved captured author groups, per-group Message membership, and matching prior imports.
- Build initial groups using resolved (trimmed) captured author strings through the shared Import Projection grouping primitive. Merge whitespace variants and every blank captured name into one group each; do not case-fold, alias, or split automatically. Keep a Message and all its Variants together during later grouping operations.
- Exclude SillyTavern role, user, system, header, avatar, and Message-content evidence from Character matching. In particular, do not transfer or interpret `is_user`.
- Rank Character suggestions using names only: exact matches, then case-insensitive matches, then fuzzy matches. Pre-fill the strongest result but require explicit confirmation before final review is complete.
- Allow the user to merge captured-name groups into one Participant and split selected whole Messages into another group. Preserve source values in the archives regardless of grouping. Keep changes reversible until commit.
- Provide exactly three resolution outcomes: fork an existing Profile into a Participant, create a Participant and new Profile, or keep a Chat-only Participant. Do not expose skip, source-role inference, or post-import reassignment.
- Treat duplicate Profile names as valid. Matching and warnings aid the user but never make names unique or append automatic suffixes.
- Require a nonblank native Participant name. For a blank captured name, pre-fill `Unknown imported author` and require user confirmation or editing.
- Use the selected Profile's current name for a forked Participant. At commit, native Author Stamps capture each resulting Participant's current name. The original exact captured author string remains in preserved import data rather than the native Author Stamp.
- Include every resulting Participant in the initial Roster and Cast. A Chat-only Participant is a complete native identity, not an unresolved placeholder.
- Make split and merge final at commit. Do not add a post-import operation that reassigns historical Messages. The recovery path for a wrong decision is another import.
- Perform all database creation for the Chat, Participants, Roster membership, Author Stamps, Messages, Variants, Conversation-scoped metadata, and newly requested Profiles as one all-or-nothing database operation. The Character System and Conversation seams must support this orchestration without importing through direct table writes.
- Keep exact artifact persistence deliberately simple and outside the database transaction. Move the successfully staged file into a unique managed relative path before database commit. If that move fails, abort import. If database commit later fails, an unused file may remain; no recovery journal or garbage collector is added.
- Add generic Conversation artifact metadata containing Chat ownership, namespace, key, managed relative path, original leaf filename, media type, byte length, and SHA-256. Use a unique `(Chat, namespace, key)` identity.
- Store one independent filesystem copy per imported Chat. Do not deduplicate content, use content-addressed storage, or reference the user's original file.
- Never automatically delete committed artifacts, including when their Chat is deleted. Missing files are treated as externally cleaned up rather than as Conversation corruption.
- Retain the existing canonical parsed archive and compact import report in Conversation-scoped data. Add the exact filesystem artifact rather than replacing canonical storage.
- Exclude exact bytes, canonical archive text, reasoning, and other heavy provenance from normal paginated Chat read models. Fetch receipt metadata and artifact content through explicit Import Details operations.
- Distinguish duplicate evidence. A matching SHA-256 means exact original bytes; matching only source-declared integrity means a related source. Declared integrity remains advisory rather than a verified content digest.
- Require a separate duplicate-copy confirmation for exact matches. Continue allowing independent copies. A new intentional import receives a new staging token and Chat identity.
- Keep the staged commit idempotent. Retrying the same token and request identity after a lost response returns the original success rather than creating another Chat.
- Open the imported Chat after commit and show a compact receipt. Persist receipt details and expose them under Chat information without adding an Imported badge, header marker, or separate category.
- Download the exact artifact on demand with the stored original leaf filename. Sanitize response headers without altering the bytes. When metadata exists but the file is absent or fails verification, report that the source artifact has been cleaned up and leave all native Chat behavior available.
- Treat import as an ingestion event. Do not add imported-only capability flags. As normal Chat editing, generation, and Control evolve, imported Chats use the same commands and availability rules.
- Add a lightweight paginated Chat read model for native Messages, Author Stamps, selected Variant state, and Variant summaries. Keep heavyweight scoped provenance lazy.
- Initialize the native selected Variant from the source `swipe_id`. Thereafter, normal swipe navigation executes the same revisioned Variant-selection command used by every Conversation and never reads or rewrites preserved source data.
- Preserve empty and duplicate Variants as distinct native positions. Render exact empty content with a presentation-only placeholder and never substitute stored text.
- Keep both source representations immutable. Normal Participant renames, Message edits, Variant edits, Variant selection, generation, and later Conversation activity mutate only native domain state.
- Defer Profile Library UI and Participant-to-Profile promotion UI to Character System work. When that system implements promotion, the intended interaction remains a Cast Participant action that stays in Chat after success and offers navigation to the created Profile.

## Testing Decisions

- Treat the deep SillyTavern Import module as the primary behavioral test seam. Exercise the same public operations used by production routes rather than testing private parser, storage, matching, or transaction helpers.
- Run server tests against a real migrated temporary SQLite database and a temporary managed artifact directory. Use the public Character System, Profile Library, and Conversation seams rather than direct table setup for behaviors those modules own.
- Follow the existing importer and Conversation test style: focused Bun tests, small synthetic JSONL fixtures, public snapshots or read models, domain errors, and externally visible artifact bytes.
- Test staged preview and commit as one behavior chain. Assert that preview and commit share the same SHA-bound bytes, a changed or expired token is rejected, and retrying a successful request returns the original Chat.
- Test exact-byte round trips using fixtures that differ in BOM, CRLF versus LF, whitespace, escape spelling, blank lines, and trailing newline. Assert the downloaded bytes and SHA-256, not filesystem helper calls.
- Test canonical parsed archive preservation separately from exact-byte preservation so that both contracts remain explicit.
- Test ordinary failure before database commit when managed artifact storage fails. Accept an unused artifact after a simulated later database failure as an intentional lifecycle tradeoff; do not build tests around cleanup that is out of scope.
- Test missing and corrupt artifacts through Import Details and download behavior. Assert that normal Chat reads and commands remain available.
- Test duplicate classification with one exact SHA match and one declared-integrity-only match. Assert explicit confirmation for the exact duplicate and continued ability to create independent copies.
- Test author grouping and resolution through preview and commit outputs: exact initial groups, case and whitespace variants, name-only ranking, unconfirmed pre-fill, explicit confirmation, merge, per-Message split, blank-name naming, existing Profile fork, new Profile creation, and Chat-only Participants.
- Test that source `is_user` and other role evidence do not affect candidates, Participant choice, Control, or Author Stamps.
- Test the final committed aggregate through native public reads. Assert Roster membership, stable Participant identifiers, resolved Author Stamp names, exact Message-to-Participant assignments, Variant order, source-selected initial Variant, and database atomicity.
- Test that a failed domain creation leaves no Chat, Participant, Profile, Message, Variant, Roster, or Author Stamp rows, while recognizing that the already moved filesystem artifact may remain.
- Test normal Variant navigation through the existing revisioned Conversation command seam. Assert that selection persists natively and neither source representation changes.
- Test paginated history through the public Chat read seam. Assert page boundaries, stable chronology, resolved authorship, selected Variant state, empty placeholders at presentation level, and exclusion of heavy archive values.
- Test the typed HTTP adapters narrowly for upload, preview, commit, receipt, pagination, and artifact download contracts. Do not duplicate the import module's full behavioral matrix at the route layer.
- Test the client resolver as a pure state transition boundary using a replaceable import client: step navigation, confirmation gates, split and merge reversibility, duplicate confirmation, recoverable errors, cancel warning, and idempotent success handling.
- Do not introduce a large frontend testing framework solely for this feature. Add only the smallest harness needed for pure resolver behavior, then perform one browser smoke test of the complete desktop and narrow-layout flow.
- Keep committed fixtures small and synthetic. Continue using one private local full-export smoke test for realistic scale without adding the private source to version control.
- Include a no-application-limit smoke case large enough to exercise streamed staging, paginated reading, and on-demand download without turning the automated suite into a storage benchmark.
- Run the repository's focused Bun tests, migration checks, typecheck, lint, build, foreign-key checks, and browser smoke validation in proportion to the implemented ticket.

## Out of Scope

- Implementing the Character System, Actor Profile Library, Participants, Roster, Author Stamps, or their underlying migrations. They are prerequisites represented by the dependency-gate ticket.
- Designing or enabling the full Character Library UI, complete Profile editor, Profile lifecycle, or Participant promotion UI as part of import.
- Creating a live link, synchronization, reset, merge, or rebase relationship between a Participant and an Actor Profile.
- Applying an existing Profile to a Chat-only Participant after import.
- Reassigning historical Messages between Participants after import. Reimport is the correction path.
- Inferring Writer, human, model, assistant, user, system, Control, or any other role from SillyTavern fields.
- Skipping Messages or omitting an author group to avoid Participant resolution.
- Batch import, folder import, multi-file shared resolution, resumable upload, or durable unfinished import drafts.
- Watching, reopening, modifying, moving, or retaining a dependency on the user's original file after staging.
- An application-level source-size cap or exact percentage progress.
- Physical artifact deduplication, content-addressed storage, reference counting, deletion on Chat removal, automatic garbage collection, crash recovery journals, or orphan cleanup.
- Treating missing exact artifacts as fatal to native Chat use.
- Displaying an Imported badge, permanent header marker, capability mode, or separate Imported Chats category.
- Embedding the full raw archive in ordinary Conversation snapshots or every command response.
- An embedded raw JSON viewer. Import Details provides metadata, warnings, and exact artifact download.
- Reconstructing a semantically equivalent JSONL export from canonical JSON. Download returns the exact stored input bytes.
- Rewriting preserved source data after native edits, Participant renames, Variant selection, or later Conversation activity.
- Replacing the existing developer database import command unless a later ticket demonstrates that removal is useful.
- Adding the private full-size export to source control.

## Further Notes

- This specification is intentionally ready in design but blocked in delivery. The dependency-gate ticket is not an instruction to implement the Character System inside this effort; it closes only when the separately owned Character System exposes the required public seams.
- The completed backend importer remains the source of truth for JSONL validation, Swipe mapping, timestamp derivation, scoped provenance, canonical archive construction, and duplicate-copy allowance unless this specification explicitly changes a behavior.
- Exact-byte preservation is a new requirement beyond the completed backend work. The source SHA is already defined over raw bytes, so it remains the verification authority. Source-declared integrity is advisory.
- Filesystem artifacts deliberately have weaker lifecycle guarantees than SQLite state. The design favors low maintenance complexity: an artifact is required at initial commit, but later disappearance affects only provenance download, and unused files may remain indefinitely.
- The known full export is roughly 24 MB with hundreds of Messages and more than a thousand Variants. It motivates streamed staging, paginated reading, and lazy provenance, but not an arbitrary size cap, batching, or durable resume system.
- The user explicitly owns ambiguity introduced by duplicate Character names and name-only matching. The product may warn and rank, but it must not enforce uniqueness or use hidden evidence to override a choice.
