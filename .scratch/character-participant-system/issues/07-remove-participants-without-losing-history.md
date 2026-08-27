# 07 — Remove Participants without losing history

**What to build:** A user can remove an unseated Participant after reviewing the impact, while historical authorship and generation references remain structurally valid through minimal tombstones when needed.

**Blocked by:** 04 — Manage Cast and Control from the Chat; 05 — Generate historical Swipe Variants.

**Status:** resolved

- [x] Seated Participants cannot be removed, and the derived removal capability explains that either Control assignment must be changed first.
- [x] Removing any eligible Participant requires confirmation showing whether the result is a hard deletion or tombstone and how many Messages lose future sibling generation.
- [x] A Participant with no authorship, historical Control, provenance-dependent, or other retained references is hard-deleted.
- [x] A referenced Participant becomes a nonrestorable tombstone retaining only stable identity, final name, Conversation identity, and source Character provenance.
- [x] Tombstoning removes the Participant from Cast and strips its Prompt, openings, and presentation data while compacting later Cast positions transactionally.
- [x] Historical Messages continue displaying their captured Author Stamp name with a no-longer-in-Cast state after removal.
- [x] Historical generation that requires a removed Participant becomes unavailable with a derived reason, while existing sibling Variants remain selectable and editable.
- [x] Re-adding the same name or source Character creates a new Participant identity and never restores or silently reuses the tombstone.
- [x] Tombstones are garbage-collected in the same domain transaction after their final retained reference disappears.
- [x] Conversation snapshots expose removal eligibility, deletion mode, affected-generation count, historical display state, and Swipe capability without client-side rule reconstruction.
- [x] The Cast UI shows the computed impact before confirmation and refreshes Control, ordering, history labels, and capabilities after success.
- [x] Real-SQLite Conversation-interface tests cover protected seats, unreferenced hard deletion, each tombstone reference kind, position compaction, regeneration loss, re-addition identity, and final-reference collection.
- [x] Focused adapter and UI tests cover typed not-removable outcomes and confirmation presentation rather than retesting persistence internals.
