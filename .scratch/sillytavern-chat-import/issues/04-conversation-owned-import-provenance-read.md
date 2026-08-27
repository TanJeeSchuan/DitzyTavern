# 04 — Read Import Details through a Conversation-owned data seam

**What to build:** Narrow the server-side Import Details read so conversation-scoped provenance is read through a Conversation-owned generic seam instead of the import module opening the chat data tables directly. The seam stays vocabulary-free: Conversation remains ignorant of import meaning, and import semantics (receipt parsing, duplicate classification, artifact availability) stay with the import domain.

**Blocked by:** 03 — Preserve SillyTavern Swipes and generation provenance.

**Status:** resolved

- [x] The Conversation module exposes a narrow `readConversationData` seam returning the Conversation name and optionally namespace/key-filtered Conversation-scoped entries; undefined for a missing Conversation, empty entries for a present Conversation with no matches.
- [x] Import Details composes its receipt entirely through the seam plus the existing artifact seam, dropping its own direct chat-table and chat-data reads.
- [x] The cross-Chat prior-import duplicate scan and its three consumers (developer import, staged preview, Import Details) are unchanged: already a single owned import-domain query, per ADR-0024.
- [x] Existence semantics preserved: a missing Chat and a Chat without import provenance both report no Import Details (merged 404), and cleaned-up artifact availability still disables only exact download.
- [x] Focused direct tests cover the seam: name plus filtered entries, namespace filter, keys filter, keys without namespace, empty keys array, missing Conversation to undefined, and present-but-empty entries.
- [x] Existing Import Details, route, and prior-import tests stay green; typecheck clean; lint clean for all touched files.

## Comments

- Scope came from architecture review Candidate 03, refined in a grilling session to do (i) only: the per-Chat receipt read moves behind a generic Conversation read seam; moving the cross-Chat prior-imports scan is explicitly skipped — it is already a single owned function, and promoting it would create the generic repository interface ADR-0024 forbids or leak import vocabulary past ADR-0013.
- The alternative "first-class import provenance read inside the Conversation aggregate" was rejected: it would reintroduce a lasting imported subtype that ADR-0026 abolished.
- Recorded as ADR-0028.
