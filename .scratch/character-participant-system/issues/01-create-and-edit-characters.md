# 01 — Create and edit Characters in the Library

**What to build:** A complete Character Library experience in which a user can create, inspect, edit, and pin reusable Characters with names, typed Prompts, and ordered openings. Character deletion remains deferred until Participant provenance exists.

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] A user can create a Character atomically from a complete Definition containing a normalized nonblank name, all typed Prompt fields, and an ordered openings list.
- [x] Prompt and opening text is preserved exactly; Prompt fields may be empty, openings may be empty or duplicated, and each stored opening must be nonblank.
- [x] Duplicate Character names are accepted, while leading and trailing name whitespace is removed and case and Unicode are preserved.
- [x] The public Character Library seam supports list, detail, and revisioned command execution without exposing database tables or generic repositories.
- [x] Rename, whole-Prompt replacement, whole-openings replacement, and pinning are separate atomic commands that require the expected Character revision and increment it on success.
- [x] A stale command returns a typed revision conflict containing the authoritative current Character without overwriting the user's local draft.
- [x] Normal library reads exclude lifecycle tombstones and sort pinned Characters first, then alphabetically within each group, using stable identity only as an invisible duplicate tie-breaker.
- [x] The dedicated Character Library UI supports list, create, detail, semantic Apply actions, pinning, computed duplicate ordinals, and conflict recovery without showing internal identifiers.
- [x] Transport endpoints are thin typed adapters over the Character Library seam and do not reproduce persistence or validation rules.
- [x] Interface-level tests use a real migrated temporary SQLite database and cover exact Definition persistence, duplicates, ordering, revisions, conflicts, and pinning.
- [x] Character seed data and its matching dependent-first teardown are updated together and remain idempotent and safe for user-created data.
- [x] Terminology and architecture documentation touched by this slice consistently use Character and Character Library rather than introducing a parallel Profile implementation.
