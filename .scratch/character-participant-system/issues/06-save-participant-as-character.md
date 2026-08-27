# 06 — Save a Participant as a Character

**What to build:** A user can promote a useful Conversation-local Participant into a new reusable Character without changing the Participant or creating a synchronization relationship.

**Blocked by:** 01 — Create and edit Characters in the Library; 04 — Manage Cast and Control from the Chat.

**Status:** resolved

- [x] The Cast drawer offers Save as Character for an active Participant with a complete Definition.
- [x] The workflow copies the Participant's current normalized name, exact typed Prompt, and ordered openings into one new Character atomically.
- [x] The operation checks the expected Conversation revision and reads the authoritative Participant Definition server-side rather than accepting a stale client copy.
- [x] Saving creates a new Character even when another Character has the same name.
- [x] The original Participant remains unchanged in its Conversation and keeps its previous provenance, including no provenance when it was ad hoc.
- [x] The new Character and original Participant have no live link, synchronization, relinking, reset, merge, or rebase behavior.
- [x] On success, the user remains in the Chat and receives an action to navigate to the new Character Library entry.
- [x] Failure produces a typed validation, not-found, or revision-conflict outcome and creates no partial Character.
- [x] The application workflow composes Character Library and Conversation capabilities in one transaction without direct client or route access to their tables.
- [x] Real-SQLite workflow tests cover exact Definition copying, duplicate names, provenance preservation, stale revisions, atomic failure, and subsequent independent edits to both records.
- [x] Focused transport and UI tests verify the command contract, local draft preservation, success navigation, and failure presentation without duplicating domain tests.
