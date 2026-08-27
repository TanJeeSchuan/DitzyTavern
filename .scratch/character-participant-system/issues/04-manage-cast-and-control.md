# 04 — Manage Cast and Control from the Chat

**What to build:** A user can manage Conversation-local Participants and both Control assignments from the Chat, including adding Character forks or ad-hoc Participants, editing local Definitions, and atomically swapping or replacing seats.

**Blocked by:** 02 — Create playable Chats from two Participants.

**Status:** resolved

Implemented in lane pi-parallel-dfcd4131-1238-4129-b0f8-8baaf4602ceb-0.

- [x] The Cast drawer displays ordered active Participants, computed duplicate labels, Control badges, Character provenance, and the actions currently allowed for each Participant.
- [x] A user can append a new Participant from a pinned-first alphabetic Character picker or from an ad-hoc complete Definition.
- [x] The picker shows duplicate ordinals, a useful Prompt preview, and a used-count while allowing the same Character to be forked repeatedly.
- [x] Adding a Character checks the expected Character and Conversation revisions and copies the authoritative server-side Definition atomically; stale copied client data cannot become the fork source.
- [x] A Participant can be renamed or have its whole Prompt or openings replaced through separate revisioned Apply actions without modifying its source Character or existing history.
- [x] The composer exposes Cast-only `Writing as` and `Responding as` selectors reflecting current human and model Control.
- [x] Selecting the opposite seat occupant is visibly described as a swap and atomically swaps the two Control assignments, including when the Cast has only two Participants.
- [x] Selecting an unseated Participant replaces only the chosen Control assignment and leaves the displaced Participant active and removable once unseated.
- [x] Neither Control seat can be cleared in a complete native Conversation, and seated Participants remain ineligible for removal.
- [x] New Participants append at a stable Cast position; manual reordering and active/inactive group-chat behavior are not introduced.
- [x] Conversation snapshots derive playability, Control validity, duplicate labels, and Participant removal eligibility so clients do not reproduce those rules.
- [x] Thin transport adapters mirror Conversation commands and explicit Character-to-Cast workflow operations without coordinating persistence in route handlers.
- [x] Real-SQLite interface and focused UI tests cover repeated forks, ad-hoc additions, semantic edits, stale source and destination revisions, replacement, two-person swaps, larger-Cast swaps, and derived capabilities.
- [x] Product documentation is amended to show two editable composer Control selectors and to defer portraits and active/inactive group behavior.

## Notes

- Participant removal (tombstones, hard-delete, confirmation impact) remains ticket 07's scope; this ticket derives and surfaces removal eligibility in snapshots and the drawer.
- Completing one-seat imports via auto seat-fill remains ticket 09's scope; the `assign-control` command supports filling a missing seat without clearing the other.