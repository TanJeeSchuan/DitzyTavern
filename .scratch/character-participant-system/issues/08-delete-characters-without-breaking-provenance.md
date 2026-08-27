# 08 — Delete Characters without breaking provenance

**What to build:** A user can delete a reusable Character after seeing its impact, while every existing Participant fork remains independent and traceable for as long as its provenance reference exists.

**Blocked by:** 01 — Create and edit Characters in the Library; 07 — Remove Participants without losing history.

**Status:** resolved

- [x] Character detail exposes a derived deletion impact containing the number of active or tombstoned Participant provenance references. (server seam `readDeletionImpact`)
- [x] Every Character deletion requires confirmation and clearly distinguishes hard deletion from retained tombstoning. (confirmed `delete` command with expected revision; typed `CharacterDeletionResult.deletionMode`; UI confirmation in the UI TODO)
- [x] An unreferenced Character is hard-deleted with its Prompt and openings in one transaction. (`delete-character.ts` inside the command transaction)
- [x] A referenced Character becomes a hidden nonrestorable tombstone retaining only stable identity and final name while its Definition and openings are stripped. (`delete-character.ts`)
- [x] Existing Participant forks keep their complete local Definitions and immutable source Character identity after source deletion. (Conversation snapshot derives `sourceCharacterName` from the tombstoned row; covered by tests)
- [x] Participant provenance is never cleared merely because the source Character is deleted. (tombstone retains the row; covered by tests)
- [x] Character tombstones are excluded from normal library lists and pickers and cannot be edited, pinned, restored, or used to create new forks. (list/get filter, `requireActiveCharacter` rejects, workflows resolve forks through `get`)
- [x] Removing the final Participant provenance reference garbage-collects an already-tombstoned Character through the narrow approved cleanup mechanism. (implementation wired in remove-participant/delete-message; tests cover both the hard-delete and tombstone-collection paths)
- [x] Creating another Character with the deleted Character's name produces a new identity and does not restore or reuse the tombstone. (fresh auto-increment row; covered by tests)
- [x] Character Library results and typed errors expose deletion impact and lifecycle state without leaking database representation. (seam types + transport exposure)
- [x] The Character Library UI presents reference counts, confirmation, success removal, and conflicts while leaving existing Chat Participants unchanged. (CharacterLibraryPanel delete section, list used counts, typed conflict banner, presentation helpers + UI-boundary tests)
- [x] Real-SQLite interface tests cover unreferenced deletion, referenced tombstoning, stripped data, hidden reads, retained forks, stable provenance, recreation, and final-reference garbage collection. (added in character-library.test.ts, participant-removal.test.ts, add-character-to-cast.test.ts, contract.test.ts)
- [x] The provenance architecture decision is amended to retain source identity through a Character tombstone rather than clearing it on deletion. (ADR 0016 paragraph: “Deleting a Character leaves every existing Participant fork unchanged… Provenance on existing Participants is never cleared.”)
