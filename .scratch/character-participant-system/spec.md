# Character and Participant System

Status: ready-for-agent

## Problem Statement

DitzyTavern currently lacks one coherent domain model for reusable Characters, Conversation-local identities, Cast membership, Control assignment, authorship, and historical Swipe generation. Existing design material separates reusable Profiles from local Participants, but still gives `Writer` special meaning in places, assumes every Conversation is immediately playable, and ties later Variant generation too closely to current Control. Those assumptions cannot represent imported Chats faithfully and make ordinary cooperative writing harder to reason about.

A reusable identity and an identity participating in one Conversation have different lifecycles. Editing a library Character must not silently rewrite an existing Conversation, while editing a Participant must not mutate a reusable Character. Duplicate names must remain valid, and a name must never become an identity key. Imported authorship must survive even when its original Participant is removed. Likewise, a Message generated under an earlier human/model pairing must retain enough historical context to generate later sibling Variants without changing the Conversation's current Control assignment.

The system also needs a clean application boundary. Character Library operations, Conversation operations, and cross-module workflows must be atomic, revision-aware, and usable through thin transport adapters. Persistence must enforce structural integrity without turning database tables or generic repositories into the domain interface. The resulting design must support native Chat creation, incomplete preservation-oriented imports, deterministic import Control assignment, Participant removal, Character deletion, and later user-facing management without creating imported-only behavior modes.

## Solution

Introduce **Character** as the reusable library entity and **Participant** as an independent Conversation-local identity. A Character or Participant owns a complete Definition consisting of a name, a typed Prompt, and ordered openings. Adding a Character to a Cast copies its current Definition into a new Participant and records immutable source provenance; it does not establish synchronization. An ad-hoc Participant has the same local capabilities without requiring a Character.

Treat **Cast** as the ordered roster of Participants in a Conversation. A playable Conversation has two distinct Control assignments: one human-controlled Participant and one model-controlled Participant. Control is independent of identity, and `Writer` has no special domain meaning. Complete native Conversations must remain playable, while imported Conversations with fewer than two resolved Participants may persist as incomplete preservation records until the missing seat is filled.

Stamp every Message with immutable authorship containing the Participant identifier and captured name. Native generated Messages additionally capture the human/model Control pair in effect when generation starts. Later sibling Variant generation uses that Message's historical pair, their current Definitions, the current generation settings, and the selected history preceding the target Message. It does not require the historical model Participant to remain the current model Control and does not modify current Control.

Expose two deep domain seams: `CharacterLibrary` for reusable Characters and `Conversation` for Cast, Control, Messages, and capabilities. Explicit application workflows create Conversations, add Characters to Casts, save Participants as Characters, and import SillyTavern Chats. These workflows compose the domain seams in one transaction, check revisions, and keep clients from submitting stale copied Definitions.

## User Stories

1. As a user, I want Character to mean a reusable library identity, so that product language matches the thing I manage globally.
2. As a user, I want Participant to mean an identity local to one Conversation, so that local changes do not unexpectedly affect other Chats.
3. As a user, I want Cast to mean the ordered Participants in a Conversation, so that the visible roster has one unambiguous name.
4. As a user, I want a Participant named Writer treated like every other Participant, so that a legacy name does not create hidden behavior.
5. As a user, I want any Participant eligible for human or model Control, so that identity and operation remain independent.
6. As a user, I want duplicate Character and Participant names allowed, so that names never become identity keys.
7. As a user, I want leading and trailing whitespace removed from names while case and Unicode are preserved, so that names remain usable without unwanted normalization.
8. As a user, I want every active Character and Participant to have a nonblank name, so that native identity is always presentable.
9. As a user, I want duplicate display names disambiguated with computed ordinals, so that I can choose between them without seeing internal identifiers.
10. As a user, I want a Character Definition to include its name, Prompt, and openings, so that a reusable identity is complete.
11. As a user, I want a Participant to own an independent copy of its Definition, so that Conversation-local editing is safe.
12. As a user, I want adding the same Character more than once to create separate Participants, so that one source can play multiple local roles.
13. As a user, I want both initial seats allowed to fork the same Character, so that distinct Control assignments do not require distinct library sources.
14. As a user, I want Character provenance retained as immutable source identity only, so that I can see where a Participant began without implying synchronization.
15. As a user, I do not want source revisions, reset, refresh, merge, rebase, or live synchronization, so that fork semantics stay predictable.
16. As a user, I want Prompt fields for System Instruction, Identity, Scenario, Example Dialogue, and Post-History Instruction, so that the full identity can be assembled deliberately.
17. As a user, I want every Prompt field stored as exact text and allowed to be empty, so that the application does not rewrite or invent prompt content.
18. As a user, I want Example Dialogue stored as raw text in its own prompt block, so that future custom prompt assembly can position it explicitly.
19. As a user, I want empty prompt blocks omitted from the rendered plan but retained in storage, so that temporary emptiness is not destructive.
20. As a user, I want prompt assembly ordered as System Instruction, human Identity, model Identity, Scenario, Example Dialogue, selected history, and Post-History Instruction, so that generation is deterministic.
21. As a user, I want only the model-controlled Participant to contribute non-Identity definition blocks, so that the active model persona owns the generated scenario and instructions.
22. As a user, I want `{{self}}` and `{{other}}` expanded relative to the Definition owner, so that the same Definition works under either Control assignment.
23. As a user, I want macros to be case-sensitive and expanded once, so that prompt rendering has simple deterministic rules.
24. As a user, I want an escaped recognized macro to remain literal, so that I can discuss macro syntax inside a Prompt.
25. As a user, I want unknown macros preserved literally and reported as prompt-inspection warnings, so that unsupported syntax is visible without destroying content.
26. As a user, I want openings to be an ordered list of exact, nonblank text entries, so that a Character can provide greeting alternatives without normalization.
27. As a user, I want openings allowed to be empty or duplicated, so that the list represents authored alternatives exactly.
28. As a user, I want changing a Participant's openings to affect no existing history, so that configuration edits are not retroactive.
29. As a user, I want a new Character created atomically from a complete Definition, so that partially configured library entries cannot leak into normal use.
30. As a user, I want name, Prompt, and openings edited with separate Apply actions, so that each semantic change is intentional and atomic.
31. As a user, I want unsaved edits kept client-local, so that typing does not create server revisions per keystroke.
32. As a user, I want stale edits rejected with the current authoritative state while my draft remains available, so that conflicts never silently overwrite work.
33. As a user, I want a dedicated Character Library route, so that reusable identities are manageable outside a Chat.
34. As a user, I want pinned Characters listed before unpinned Characters and each group alphabetized, so that frequent identities are easy to find.
35. As a user, I want pinning to be a simple boolean with no manual pin ordering, so that the feature remains low maintenance.
36. As a user, I want the Character picker to show duplicate ordinals, prompt preview, pinning, and how many times a Character is already used, so that repeated forks are deliberate.
37. As a user, I want already-used Characters to remain selectable, so that the UI does not impose false uniqueness.
38. As a user, I want to save a Participant as a new Character, so that a useful local identity can become reusable.
39. As a user, I want saving a Participant to copy its current complete Definition without relinking it, so that the new Character and Participant remain independent.
40. As a user, I want the save action to offer navigation to the new Character while leaving me in the Chat, so that the workflow remains contextual.
41. As a user, I want a native New Chat flow to require two distinct Participants before commit, so that every native Chat begins playable.
42. As a user, I want each initial seat to use either a Character fork or an ad-hoc Definition, so that library membership is optional.
43. As a user, I want the initial human and model setup shown side by side, so that the two Control assignments are clear before creation.
44. As a user, I want the initial model Participant's openings to become one Message with ordered sibling Variants, so that configured greetings use native history.
45. As a user, I want the first opening selected initially and no Message created when there are no openings, so that startup behavior is deterministic.
46. As a user, I do not want human openings or later Cast changes to insert history automatically, so that only initial model setup creates a greeting.
47. As a user, I want a Conversation playable only when two distinct Cast Participants occupy human and model Control, so that generation always has a complete pair.
48. As a user, I want seated Participants protected from removal, so that a complete native Conversation cannot be made incomplete accidentally.
49. As a user, I want an unseated Participant removable after confirmation, so that I can manage additional Cast members.
50. As a user, I want selecting the opposite seat's occupant to swap the two assignments atomically, so that a two-person Cast can never become locked.
51. As a user, I want the UI to label that choice as a swap, so that the resulting Control change is not surprising.
52. As a user, I want reassignment to make a displaced unseated Participant removable, so that removal eligibility follows current Control rather than history.
53. As a user, I want Cast position stable and explicit, so that snapshots and UI ordering remain deterministic.
54. As a user, I accept append-only Cast ordering in the first version, so that manual reordering does not delay the core system.
55. As a user, I want positions compacted when an unseated Participant is removed, so that the Cast remains contiguous.
56. As a user, I want imported source authors resolved into named Participants without trusting SillyTavern role hints, so that source remnants do not dictate native identity.
57. As a user, I want blank source author names retained in the archive but resolved to a usable native name, so that preservation and usability both hold.
58. As a user, I want imported Control assigned deterministically from first source appearance, so that missing source metadata does not require fabricated semantics.
59. As a user, I want the first resolved Participant assigned human Control and the second model Control, with later Participants unseated, so that import produces a stable initial result.
60. As a user, I want a single existing assignment preserved when a second Participant is added, so that completing an imported Chat does not reshuffle an intentional choice.
61. As a user, I want an import with zero or one Participant allowed to persist, so that preservation does not fail merely because a Chat is not yet playable.
62. As a user, I want incomplete imported history readable, editable, exportable, configurable, and deletable, so that incompleteness blocks play rather than custody of my data.
63. As a user, I want Compose, Generate, and Swipe blocked in an incomplete Chat with a clear reason, so that unsupported actions do not partially execute.
64. As a user, I want adding the missing Participant to complete an imported Chat automatically, so that no separate status toggle is needed.
65. As a user, I want every Message stamped with immutable Participant identity and captured name, so that authorship survives later renames.
66. As a user, I want all sibling Variants of one Message to share its Author Stamp, so that a Swipe cannot change who authored the Message.
67. As a user, I want content edits to preserve the Author Stamp, so that editing prose does not rewrite authorship.
68. As a user, I want a generated Message to capture the human/model Control pair at generation start, so that later Variant generation can reproduce its participant context.
69. As a user, I want prompt plan and authorship captured at generation start, so that concurrent Definition or rename edits affect only later generations.
70. As a user, I want a later Swipe on an older native Message to use its historical model Participant even when current model Control has changed, so that current Control does not invalidate history.
71. As a user, I want historical Swipe generation to leave current Control unchanged, so that generating a sibling Variant is not a seat reassignment.
72. As a user, I want historical Swipe generation to use the historical pair's current Definitions and names, current generation settings, and current preceding selected history, so that regeneration uses present configuration within the original participant relationship.
73. As a user, I want `self` and `other` resolved from the target Message's historical pair, so that macros remain coherent for older Messages.
74. As a user, I want the target Message's sibling Variants excluded from its preceding history, so that a generated alternative does not prompt on another alternative.
75. As a user, I want a configured greeting to support generating an additional Variant at the end of its openings, so that openings and generated alternatives share one Swipe model.
76. As a user, I want current Generate after a Control change to create a new Message authored by the current model Participant, so that only targeted Swipe uses historical Control.
77. As a user, I want imported Variants selectable and editable even when they lack historical Control context, so that preserved history remains useful.
78. As a user, I accept that imported Messages without trustworthy generation context cannot generate new sibling Variants, so that the system does not invent historical roles.
79. As a user, I want removing a referenced Participant to retain a minimal tombstone, so that authorship and historical references remain structurally valid.
80. As a user, I want a removed Participant displayed using the Message's captured name and marked as no longer in Cast, so that history stays understandable.
81. As a user, I want Participant removal confirmation to explain whether it will hard-delete or tombstone and how many Messages lose regeneration, so that I can judge the impact.
82. As a user, I want an unreferenced removed Participant hard-deleted, so that unused records do not accumulate.
83. As a user, I want re-adding a removed identity to create a new Participant identifier, so that deletion is not disguised as restoration.
84. As a user, I want deleting a Character to leave all existing Participant forks unchanged, so that Conversations never depend on the library source remaining active.
85. As a user, I want Character deletion confirmation to show the number of provenance references, so that I understand whether a tombstone is required.
86. As a user, I want referenced deleted Characters reduced to hidden minimal tombstones and unreferenced Characters hard-deleted, so that traceability is kept only when needed.
87. As a user, I want tombstones garbage-collected when their final reference disappears, so that preservation has bounded storage cost.
88. As a user, I want a Cast drawer showing ordered Participants, Control badges, provenance, and allowed actions, so that Conversation-local identity is manageable in one place.
89. As a user, I want a Participant editor with separate Apply actions for name, Prompt, and openings, so that local configuration follows the same atomic editing model as Characters.
90. As a user, I want both `Writing as` and `Responding as` selectors in the composer, so that human and model Control are visible and editable at the point of play.
91. As a user, I want those selectors limited to Cast Participants, so that Control cannot reference an identity outside the Conversation.
92. As a user, I want an incomplete import to show a persistent setup panel and no play actions, so that the path to completion is obvious.
93. As a user, I want derived capability reasons in the Conversation snapshot, so that every client presents the same playability, removal, deletion, and Swipe rules.

## Implementation Decisions

- Use **Character**, **Participant**, **Cast**, **Control**, **Definition**, **Prompt**, **Opening**, **Author Stamp**, and **historical Control context** as the ubiquitous language. `Writer` is an ordinary possible name, not a type, Control, seat, or stored Message intent.
- Define a Character as a reusable library record and a Participant as an independent Conversation-local fork or ad-hoc identity. Store immutable optional `sourceCharacterId` provenance on the Participant. Do not store a source revision or implement synchronization behavior.
- Define a shared conceptual Definition with a normalized nonblank name, typed Prompt, and ordered openings. Character and Participant persist their own relational copies rather than sharing mutable Definition rows or serializing the Definition as opaque JSON.
- Preserve Prompt text exactly. Prompt fields are required string fields but may be empty and have no arbitrary application length limit. Store Example Dialogue as raw text in its own typed field.
- Compile prompt blocks in this fixed order: System Instruction, human Identity, model Identity, Scenario, Example Dialogue, selected history, Post-History Instruction. Both identities participate; only the model-controlled Definition contributes the other Definition blocks. Omit empty blocks only from the rendered plan.
- Support `{{self}}` and `{{other}}` in the first version. Macros are case-sensitive, owner-relative, single-pass, and expanded when compiling prompts or openings. A backslash escapes a recognized macro. Unknown macros remain literal and produce a prompt-inspection warning. Expansion output is not rescanned.
- Store openings as ordered, exact, nonblank text rows. Allow an empty list and duplicate entries. Do not impose an arbitrary length limit.
- Use separate semantic commands for rename, whole-Prompt replacement, and whole-openings replacement. Draft locally and Apply atomically. New Character creation accepts the full Definition in one command.
- Expose a deep `CharacterLibrary` seam with list, detail, and command execution operations. Commands cover creation, rename, Prompt replacement, openings replacement, pinning, and deletion.
- Give every Character an independent revision. Every Character mutation except creation requires its expected revision. Pinning increments the same revision. Return typed conflicts with the current authoritative Character while leaving client drafts intact.
- Exclude Character tombstones from normal library reads. Sort pinned Characters first, then alphabetically within pinned and unpinned groups, with stable identifier ordering only as an invisible duplicate tie-breaker.
- Do not add Character Library subscriptions in the first version. A future push seam must wait for a real consumer; current clients detect stale state through revision conflicts and reload.
- Keep the existing deep `Conversation` snapshot and command execution seam. Expand its snapshot to include full Cast Definitions, provenance, Control, Messages, Author Stamps, historical generation context, playability, and derived capabilities.
- Keep Cast position explicit and stable. Append new Participants in the first version. Enforce nonnegative unique positions structurally and compact later positions transactionally after removal; maintain contiguity in the Conversation domain.
- Model Control as two nullable Conversation references for human and model Participants. Require distinct Participants when both are set. Null is allowed only to represent incomplete imports and their completion workflow; native creation requires both seats.
- Derive playability from Control and Cast state rather than storing a status flag. A Conversation is playable only when both distinct Control Participants exist in its Cast.
- Protect both seated Participants from removal. Selecting the opposite seat occupant in either Control selector performs one atomic swap. Selecting an unseated Participant replaces that seat occupant without deleting or otherwise changing the displaced Participant.
- On native creation, require two distinct Participant instances and accept either a Character source or an ad-hoc full Definition for each. Allow both instances to fork the same Character.
- Convert the initial model Participant's openings into one initial Message whose ordered Variants match the openings and whose first Variant is selected. Create no greeting Message if the list is empty. Ignore human openings during creation, and never insert openings when adding or reassigning Participants later.
- Give every Message one immutable Author Stamp containing Participant identifier and captured name. Store authorship on the Message rather than individual Variants; content editing and Variant selection cannot change it.
- For native model generation, also store the human and model Participant identifiers active when generation starts. Capture the Prompt Plan and Author Stamp at the same boundary. The Message's historical Control context is immutable.
- Determine targeted Swipe generation from the target Message, not current model Control. Use its historical pair's current Definitions and names, current generation settings, and current selected history before the target. Resolve macros using the historical pair and leave current Control untouched.
- Permit an initial opening Message to generate another sibling Variant because it has native historical Control context. Exclude all sibling Variants of the target Message from its preceding prompt history.
- If either Participant required by historical generation is no longer active, expose the existing Variants but deny a new sibling Variant with a typed capability reason. Imported Messages that never had trustworthy historical context follow the same unavailable behavior.
- Resolve imported author groups to named Participants and stamp every imported Message. Preserve exact raw source names, including blanks, only in the import archive. Ignore `is_user`, header roles, `Writer`, and other SillyTavern role hints.
- Assign import Control deterministically by first resolved Participant appearance: first human, second model, remaining Participants unseated. With one existing assignment, preserve it and fill the missing seat with the newly added Participant. With neither assignment, the first two Participants fill human then model.
- Allow imports with zero or one Participant to commit as incomplete. Permit reads, edits, exports, configuration, and deletion, but block Compose, Generate, and Swipe until two distinct seats exist. Adding the missing Participant derives a playable state automatically.
- Do not let deterministic current Control reinterpret imported history. Existing imported Variants remain selectable and editable, but cannot gain fabricated historical generation context.
- Confirm every unseated Participant removal. Compute and present whether removal will hard-delete or tombstone and how many Messages lose future generation. Hard-delete only when no Author Stamp, provenance, Control-history, or other structural reference requires the Participant.
- Reduce a referenced removed Participant to a nonrestorable tombstone containing stable identifier, final name, Conversation identity, and Character provenance. Remove it from Cast and delete its Prompt, openings, and presentation data. Historical Messages continue displaying their captured names with a no-longer-in-Cast state.
- Confirm Character deletion with reference counts. Leave all Participant copies unchanged. Hard-delete an unreferenced Character; otherwise keep a hidden, nonrestorable base tombstone with stable identifier and final name while stripping its Definition and openings. Do not clear Participant provenance.
- Garbage-collect tombstones in the same transaction that removes the final reference. Keep Participant cleanup inside the Conversation domain. A narrow database cleanup mechanism may remove an already-tombstoned source Character after its final provenance reference is deleted; do not introduce general business-rule triggers.
- Persist Character and Participant lifecycle records separately from their required active Prompt rows and ordered opening rows. Tombstoning removes Definition children while retaining the minimal referenced base row.
- Store Message authorship and historical Control with same-Conversation relational references. Enforce structural foreign keys, unique Cast position, opening order, and distinct Control constraints in SQLite; enforce workflow and playability policies in the domain.
- Keep Drizzle and SQLite behind the deep modules. Do not introduce generic repositories or expose per-table CRUD interfaces.
- Add explicit application workflow entry points for creating a Conversation, adding a Character to a Cast, saving a Participant as a Character, and importing a SillyTavern Chat. Each workflow composes public module capabilities in one transaction.
- For a Character-to-Participant fork, check both the expected source Character revision and expected destination Conversation revision inside the workflow. Copy the authoritative Character Definition server-side; never accept a stale client-submitted Definition as the source of truth.
- Saving a Participant as a Character copies the Participant's current complete Definition into a new Character and leaves the Participant's provenance unchanged. It does not relink or synchronize the two records.
- Return typed domain outcomes for revision conflict, validation failure, not found, not playable, generation in progress, invalid Control, not removable, and unavailable historical generation context.
- Keep HTTP routes as thin typed adapters mirroring Character Library list/detail/command, Conversation snapshot/command, and the explicit cross-module workflows. Do not let routes coordinate tables or reproduce domain rules.
- Build a secondary Character Library route for CRUD and pinning. Build a Conversation-local Cast drawer for add, edit, remove, provenance, Control badges, removal eligibility, and saving as Character.
- Use a side-by-side human/model setup surface for New Chat. For incomplete imports, keep history visible while showing a persistent completion surface and withholding play actions.
- Put two Cast-only Control selectors in the composer toolbar: `Writing as <human>` and `Responding as <model>`. Show the atomic swap consequence when the opposite occupant is selected and apply the change without a modal.
- Show computed duplicate ordinals instead of internal identifiers. In Character selection, include Prompt preview, pin priority, and a used-count while allowing repeated selection.
- Destructively reset and reseed pre-Participant development data rather than fabricating migrations for obsolete local rows. Use generated migrations for the new schema and keep seed and teardown data symmetric.

## Testing Decisions

- Test primarily through the public `CharacterLibrary`, `Conversation`, and application workflow interfaces using a real migrated temporary SQLite database. Treat those seams, not internal command helpers or tables, as the behavioral contract.
- Cover Character creation, exact Definition persistence, duplicate names, pin ordering, semantic edits, revision increments, conflicts, deletion impact, tombstones, and final-reference garbage collection through `CharacterLibrary` reads and commands.
- Cover native Conversation creation with two ad-hoc Participants, two different Character forks, and two forks of the same Character. Assert distinct local identifiers, copied Definitions, immutable provenance, Control, Cast order, and derived playability.
- Cover model openings as initial sibling Variants, including empty lists, duplicates, exact text, initial selection, Author Stamp, and historical Control context. Assert that human openings and later Cast operations do not insert Messages.
- Cover atomic Control reassignment and opposite-seat swaps with two and more Participants. Assert that a complete native Conversation never loses a required seat and that removal eligibility updates from the resulting state.
- Cover deterministic import assignment for zero, one, two, and more resolved Participants. Assert that source role hints have no effect and that completing a one-seat import preserves the existing assignment.
- Cover incomplete import capabilities through the public snapshot and commands. Assert that read, edit, export, configuration, and deletion remain available while Compose, Generate, and Swipe return the same typed not-playable outcome.
- Cover Author Stamp immutability across Participant rename, Message edit, Variant selection, and additional sibling generation. Assert that every sibling retains the Message author and captured name.
- Cover generation-start snapshots by changing names, Prompts, and Control during an in-flight generation. Assert that the active operation keeps its captured Prompt Plan, author, and historical pair while later operations use current state.
- Cover historical Swipe after current model Control changes. Assert that it uses the target Message's pair, current Definitions of that pair, current generation settings, and preceding selected history without mutating current Control.
- Cover historical macro resolution, an opening Message's generated next Variant, and exclusion of target siblings from history. Cover denial when historical context is absent or a required Participant has been removed.
- Cover imported Messages with selectable and editable Variants but no new sibling generation. Assert that deterministic current Control does not retrofit or reinterpret their history.
- Cover Participant removal impact, hard deletion, tombstoning, Cast compaction, historical display, lost regeneration count, and nonrestorable re-addition through Conversation commands and snapshots.
- Cover Character deletion independently from Participant copies. Assert Definition stripping, library hiding, provenance retention, hard deletion when unreferenced, and garbage collection after the final reference disappears.
- Cover every cross-module workflow as an atomic operation, including expected Character and Conversation revisions. Simulate stale source and stale destination conflicts and assert that no partial fork, Character, Participant, or Conversation change commits.
- Cover database structural constraints with focused integration cases for same-Conversation references, distinct Control, unique nonnegative positions, ordered openings, and foreign-key enforcement. Avoid duplicating domain policy tests as raw SQL tests.
- Test thin HTTP adapters for request and response contracts, typed error mapping, and revision propagation. Do not repeat the full domain matrix at the transport layer.
- Test client state around local drafts, Apply, conflict reload, computed duplicate labels, swap labels, incomplete-state gating, removal confirmation impacts, and Character deletion impacts at the narrowest useful UI boundary.
- Run a browser smoke test covering Character creation and pinning, native Chat setup, Cast editing, composer Control swap, Participant promotion, incomplete import completion, and historical Swipe behavior.
- Update seed and teardown fixtures together and verify that seed remains idempotent while teardown deletes dependent seeded rows before parents and never removes user-created data.
- Run focused Bun tests, migration checks, type checking, linting, build, and foreign-key verification in proportion to each implementation ticket.

## Out of Scope

- Treating Writer as a privileged entity, special Control, Message intent, or default system role.
- Active and inactive Cast membership or group-chat turn-taking behavior.
- Cast drag-and-drop or manual reordering in the first version.
- Portraits, avatars, alternate artwork, or other Character presentation media.
- Character tags, folders, search, filters, and manual library ordering beyond pinning and alphabetic order.
- Tavern Card or Character-card import and export.
- General SillyTavern macro compatibility in the first version beyond `{{self}}` and `{{other}}`; broader compatibility is a later goal.
- Character-to-Participant or Participant-to-Character synchronization, relinking, reset, refresh, merge, rebase, or source revision tracking.
- Restoring tombstoned Characters or Participants. Re-creation always produces a new identity.
- Push subscriptions for Character Library or Conversation state before a real multi-client consumer exists.
- Fabricating historical Control context for imported Messages.
- Imported-only capability flags or long-term imported Chat modes. An import becomes a normal Conversation, with playability derived from native state.
- Arbitrary application-level Prompt, opening, Cast, or Character-count limits.
- Generic repositories, per-table service interfaces, or database-trigger implementations of ordinary business rules.
- Migrating or preserving obsolete pre-Participant development seed data.

## Further Notes

- This specification supersedes prior terminology that used Actor Profile or Profile Library for the reusable identity surface. The implementation seam is `CharacterLibrary`, and the user-facing reusable entity is Character.
- Targeted architecture and design amendments are required before implementation. Existing decisions that restrict Swipe generation to the currently model-controlled Participant must be revised to use Message-captured historical Control. Existing assumptions that every Conversation always has both seats need the narrow incomplete-import exception. Existing provenance cleanup guidance must retain source identifiers through Character tombstones rather than clearing them.
- Product design material that treats Writer as a special identity, assumes a single Control selector, or requires portraits in this scope must be reconciled with this specification. The agreed composer exposes both human and model Control, while portraits are deferred.
- The historical Control pair answers “who was playing when this Message was generated”; it is not a second current Control assignment. Current Control continues to govern new Messages, while the target Message governs sibling Variant generation.
- A Control assignment is therefore simply a Conversation's current mapping of one Cast Participant to the human seat and another distinct Cast Participant to the model seat. It does not describe authorship retroactively.
- “Incomplete import” means a preserved imported Conversation with fewer than two distinct Participants available for the two Control seats. It is a derived, temporary lack of playability rather than a separate Chat type.
- Character and Participant tombstones exist only to satisfy live structural references. Their stripped Definitions cannot be recovered, and they should disappear automatically after their final reference is removed.
- Delivery should proceed in coherent follow-up tickets: destructive schema and seed changes; Character Library; Participant, Cast, Control, authorship, and historical generation; cross-module workflows and import integration; then transport and UI. Those tickets should amend the affected ADR and design statements explicitly rather than leaving two competing sources of truth.
