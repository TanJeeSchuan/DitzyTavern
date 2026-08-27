# SillyTavern Chat Import

Status: ready-for-agent

## Problem Statement

As a DitzyTavern developer, I have an existing SillyTavern Chat export in JSONL format that I need to load into the application's disposable development database. The current application has native Chat, Message, Variant, scoped-data, and Character-membership storage, but it has no supported Conversation creation/import operation, no SillyTavern adapter, and no per-Variant timestamp. Direct table writes would bypass the Conversation module's invariants, while replaying hundreds of ordinary commands would create unnecessary revision churn and repeatedly materialize a growing Conversation snapshot.

The source export must remain value-lossless inside SQLite while its useful content is projected into native DitzyTavern concepts. It includes multiple assistant identities, alternative Swipes, exact selected-Swipe state, empty and duplicate alternatives, generation diagnostics, reasoning and reasoning signatures, and many SillyTavern-specific fields that DitzyTavern does not yet model. The importer must preserve the complete source without allowing the legacy format to dictate the native schema.

## Solution

Add a reusable, atomic Conversation creation operation that accepts a complete native Conversation aggregate and enforces the same invariants as later Conversation commands. Build a separate SillyTavern JSONL adapter that validates and maps the export into that generic creation input, then expose it through a small developer-facing database import command.

Each imported source record becomes a Message with at least one Variant and exactly one selected Variant. Records with SillyTavern Swipes derive their native content and promoted generation metadata exclusively from `swipes` and `swipe_info`; records without Swipes receive one selected Variant derived from their row payload. Add a timestamp to Variants so every alternative retains its generation time while the Message retains stable chronology.

Store one canonical JSON archive containing the parsed header and all parsed source message objects in Conversation-scoped data. This archive makes the database value-lossless and self-contained without adding legacy-shaped columns. Promote only the agreed operational metadata into scoped entries for current use. Persist a compact import report and print a concise command summary.

## User Stories

1. As a DitzyTavern developer, I want to import a SillyTavern Chat JSONL file, so that I can work with existing Chat history in the development database.
2. As a DitzyTavern developer, I want import to use the Conversation module, so that imported data obeys the same domain invariants as application-created data.
3. As a DitzyTavern developer, I want the SillyTavern adapter separated from generic Conversation creation, so that the legacy format does not become the Conversation module's public language.
4. As a DitzyTavern developer, I want import to run from a small database command, so that I can load a local export without building the deferred UI.
5. As a DitzyTavern developer, I want the filename stem used as the temporary Chat name, so that the command needs only the source path.
6. As a DitzyTavern developer, I want every imported Message to own at least one Variant, so that imported history satisfies the native Message invariant.
7. As a DitzyTavern developer, I want every imported Message to have exactly one selected Variant, so that its visible content is deterministic.
8. As a SillyTavern user, I want all source Swipes preserved in their original order, so that alternative generations are not lost.
9. As a SillyTavern user, I want the exact source `swipe_id` selected, so that the imported Chat retains my saved choice.
10. As a SillyTavern user, I want empty Swipes preserved, so that the importer does not rewrite unusual but valid saved state.
11. As a SillyTavern user, I want duplicate-text Swipes preserved as distinct Variants, so that their distinct timestamps and generation metadata survive.
12. As a SillyTavern user, I want payload-only records converted into a single selected Variant, so that user-written Messages and other non-Swipe records remain readable.
13. As a DitzyTavern developer, I want top-level assistant payload duplication ignored by the native projection when Swipes exist, so that selected-Swipe content and metadata are not stored twice as competing facts.
14. As a DitzyTavern developer, I want each Variant to retain its own timestamp, so that alternative-generation chronology is preserved.
15. As a DitzyTavern developer, I want each Message timestamp to remain stable, so that changing Variant selection cannot change Conversation chronology.
16. As a DitzyTavern developer, I want Chat creation and activity times derived deterministically, so that imported Chats sort consistently.
17. As a DitzyTavern developer, I want captured author names preserved without importing roles, so that useful identity survives without introducing an unwanted authorship model.
18. As a DitzyTavern developer, I want a blank captured author name preserved and reported, so that the importer does not invent an identity.
19. As a DitzyTavern developer, I want imported Chats to start with no Character memberships, so that author names are not incorrectly treated as existing Character identities.
20. As a future DitzyTavern user, I want Character creation and attachment left to a later UI, so that import does not make premature roster decisions.
21. As a DitzyTavern developer, I want provider, model, generation identifiers, timing diagnostics, reasoning, and reasoning signatures promoted per Variant, so that useful generation provenance is queryable.
22. As a DitzyTavern developer, I want unrecognized and source-only fields retained in an opaque archive, so that no parsed source value is destroyed.
23. As a DitzyTavern developer, I want unknown fields ignored by the normalized projection, so that future SillyTavern additions do not break import or expand the native model automatically.
24. As a DitzyTavern developer, I want the parsed source archive stored in SQLite, so that the disposable database remains a self-contained dump that can later be exported or reinterpreted.
25. As a DitzyTavern developer, I want import identity, counts, and warnings stored with the Chat, so that the result remains explainable after the terminal session ends.
26. As a DitzyTavern developer, I want a concise terminal summary, so that I can immediately see what was imported and what unusual state was encountered.
27. As a DitzyTavern developer, I want the whole import committed atomically, so that an invalid source cannot leave a partial Conversation.
28. As a DitzyTavern developer, I want structural source defects to abort import, so that the database never contains an improvised or ambiguous mapping.
29. As a DitzyTavern developer, I want blank names and empty or duplicate Swipes treated as valid, so that strict validation does not erase legitimate source state.
30. As a DitzyTavern developer, I want duplicate imports allowed, so that I can deliberately create independent Chat copies from the same export.
31. As a DitzyTavern developer, I want duplicate imports to retain the same source identity while receiving new Chat IDs, so that their shared origin and independent native identity are both clear.
32. As a DitzyTavern developer, I want a warning when the same source appears to have been imported already, so that accidental duplication remains visible without blocking intentional duplication.
33. As a DitzyTavern developer, I want imported Conversations to begin at revision zero, so that the concurrency counter represents mutations after creation rather than importer mechanics.
34. As a DitzyTavern maintainer, I want existing Variants backfilled safely when their timestamp is introduced, so that the schema migration preserves current data.
35. As a DitzyTavern maintainer, I want focused automated coverage without tracking the private rescue export, so that tests remain small and maintainable.
36. As a DitzyTavern developer, I want to smoke-test the complete local export separately, so that the real 24.4 MB shape is verified without entering source control.

## Implementation Decisions

- Add one generic Conversation-owned creation operation that accepts a complete native aggregate, validates it, persists it in one SQLite transaction, and returns the created Conversation snapshot. This is the highest application seam for creation and the primary test seam.
- Keep the SillyTavern adapter in a separate module. It parses and maps legacy JSONL into the generic creation input; the generic Conversation interface must not expose SillyTavern-shaped types or terminology.
- Expose a thin direct Bun database command that accepts a positional JSONL path. Add it alongside the existing database utility commands. The temporary Chat name is the source filename stem.
- Read the source explicitly as UTF-8 and parse every nonempty JSONL line. The first record is the source header and subsequent records are source Messages.
- Add a required timestamp to Variants. Backfill existing Variants from their owning Message timestamp in the migration.
- Define Message timestamp as the earliest timestamp among its Variants. A payload-only Message and its synthetic Variant receive the same source timestamp.
- Define Chat creation time as the earliest Message timestamp and Chat last-message time as the latest timestamp across every Variant.
- Preserve the established invariant that every stored Message owns at least one Variant and exactly one Variant is selected. Conversation creation must reject a Message without Variants or without exactly one selected Variant.
- When a source record has Swipes, create one native Variant for each Swipe in source order and select exactly `swipe_id`.
- When Swipes exist, derive Variant content, timestamps, reasoning, signatures, and other promoted generation metadata from the corresponding Swipe and `swipe_info`. Do not promote the duplicated top-level assistant payload.
- When a source record has no Swipes, create one selected Variant from its row payload and attach applicable row-level provenance to that Variant.
- Preserve empty and duplicate Variant content exactly. Do not deduplicate, trim, substitute, or select a nearby nonempty alternative.
- Retain captured author name as transitional Message-scoped metadata. Do not store or derive user, assistant, or system roles. Preserve a blank captured name and add a warning to the report.
- Create the imported Chat with no Character memberships. Character creation and attachment are deferred to UI work.
- Use one transitional `import.sillytavern` metadata namespace. It may later be split or discarded when native provenance and authorship models exist.
- Promote source Swipe index, provider/API, model, generation ID, generation start and finish timestamps, duration, time to first token, reasoning duration and type, finish outcome, nonempty reasoning, and reasoning signatures into Variant-scoped metadata when present. Do not manufacture empty placeholders for absent values.
- Preserve prompts, memory, persona and avatar filenames, unused fields, unknown fields, and any other non-promoted data only in the raw archive.
- Store one canonical archive object containing the parsed header and parsed source message array in an existing Conversation-scoped text value. Serialize the object as JSON. Value fidelity is required; original whitespace, line endings, and key ordering are not contractual.
- Do not add a JSON column. The existing text value stores the serialized archive.
- Keep the raw archive separate from derived import data. Store source integrity UUID, source SHA-256, importer version, counts, warnings, and the JSON import report as separate Conversation-scoped entries.
- Ignore unknown fields when constructing the normalized Conversation. Their values remain available through the raw archive; unknown paths do not need individual warnings.
- Validate the complete source before writing. Invalid JSON, missing required content, invalid timestamps, an out-of-range selected Swipe index, or mismatched Swipe and Swipe-info arrays abort the import.
- Treat blank names and empty or duplicate Swipes as valid source state. Report the blank name without changing it.
- Persist the complete Chat, Messages, Variants, scoped metadata, raw archive, and report in one transaction. Any failure rolls back the entire creation.
- Set a newly imported Conversation revision to zero. Revision is an optimistic-concurrency counter, not an audit log or imported-history count.
- Allow importing the same integrity UUID or source hash more than once. Each import creates a new Chat ID and retains the shared source identity. Report existing matching imports as a warning but do not block creation.
- Keep Elysia routes, client Message rendering, and seed data outside this feature. The importer is a developer database utility over the Conversation seam.

## Testing Decisions

- Test at the highest useful seam: generic Conversation creation against an in-memory migrated SQLite database. Assert returned snapshots and externally visible database behavior rather than helper calls or SQL implementation details.
- Test the SillyTavern adapter through its public parse-and-import behavior into the generic creation seam. Avoid separate tests for every parser helper.
- Follow the existing Conversation test style: Bun tests, an in-memory migrated database, and assertions against the public Conversation snapshot and domain errors.
- Keep fixtures small. Construct minimal synthetic JSONL records in test code or temporary files; do not track the private rescue export or add a large sample-data fixture.
- Cover the essential behaviors: Swipe order and exact selection, payload-only fallback, empty selected content, duplicate-text Variants remaining distinct, captured and blank author names, Variant and Message timestamp derivation, promoted reasoning and reasoning signatures, raw archive preservation, revision zero, duplicate imports, and atomic rollback on one representative structural error.
- Avoid exhaustive tests for every optional SillyTavern field. Representative metadata assertions and the lossless raw archive provide the useful contract without overengineering the suite.
- Run one local smoke test using the untracked full rescue export. Verify the expected aggregate counts, selected Variants, timestamp bounds, raw archive, report, and successful Conversation snapshot. This full-file check is not a committed automated fixture.
- Run the repository's normal lint, typecheck, build, focused Bun tests, migration checks, and SQLite foreign-key check in proportion to the implemented changes.

## Out of Scope

- Import UI, file picker, progress display, or Chat naming dialog.
- Rendering imported Messages in the current client.
- Native Participant, Author Stamp, user/assistant role, or system-message persistence.
- Automatic Character creation, exact-name matching, or Chat membership inference.
- Character attachment UI; a future UI may create or attach Characters after import.
- Native prompt, memory, persona, avatar, reasoning, or generation-provenance domain models.
- Exporting the canonical archive back to SillyTavern JSONL.
- Byte-identical reproduction of the source file.
- Resumable or batched import.
- Replacing, merging, skipping, or deduplicating existing imports.
- Adding the rescue export or other private sample data to source control.
- Adding a JSON database column or reshaping scoped data storage generally.
- Treating import as database seed data or changing seed/teardown behavior.

## Further Notes

- The inspected source contains one header and 833 Messages: 415 payload-only user records and 418 assistant records with 1,209 source Swipes, producing 1,624 native Variants.
- The source includes Writer, Rulership, TANJS, and one blank captured author name. Roles are intentionally not imported.
- The source contains empty and duplicate alternatives, including a final Message whose selected Swipe is empty. These are required fidelity cases, not malformed data.
- The complete source is approximately 24.4 MB. Swipe-level reasoning accounts for a substantial portion of it, so the implementation should be straightforward and memory-conscious without introducing streaming, batching, compression, or resumability unless actual measurements demonstrate a need.
- The raw archive and promoted reasoning intentionally duplicate some text. This is accepted to keep the database self-contained while making agreed provenance directly accessible.
- The general every-Message-has-a-Variant invariant is now explicit in the relevant Variant ADR. The creation seam must preserve it rather than relying on database foreign keys to enforce the presence of a child row.
