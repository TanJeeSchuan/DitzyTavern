# 04 — Resolve Participants and commit the Chat

**What to build:** Complete the staged import flow by giving the user final authority over Participant grouping and Character choices, presenting the exact operation for review, and committing one ordinary native Chat. The result must use the Character System and Conversation public seams, preserve every Message, create resolved Author Stamps, tolerate intentional duplicates, and open the new Chat without introducing an imported-only capability mode.

**Blocked by:** 01 — Character System dependency gate; 02 — Preserve the exact original import artifact; 03 — Choose and preview a staged Chat import.

**Status:** resolved

- [x] Every resolved captured-name group requires an explicit resolution outcome before commit: fork an existing Character, create a new Character, or keep a Chat-only Participant.
- [x] The resolver never offers Message skipping and never interprets `Writer`, `is_user`, or any other SillyTavern field as native identity or Control.
- [x] Users can merge several captured-name groups into one Participant and undo the merge before commit.
- [x] Users can inspect a group's Messages, move selected whole Messages into another Participant group, and undo the split before commit; all Variants remain with their owning Message.
- [x] Source author strings remain exact in preserved import data regardless of merge, split, or Character selection.
- [x] Forking an existing Character uses the Actor Profile's current name and creates a full independent Participant fork without a live Profile link.
- [x] Creating a new Character creates a minimal editable Profile and the Conversation-local Participant without enforcing name uniqueness or adding an automatic suffix.
- [x] Keeping chat-only creates a complete native Participant and does not label it unresolved or degraded.
- [x] Blank captured-name groups cannot commit until the user confirms or supplies a nonblank Participant name.
- [x] Every resulting Participant belongs to the initial Roster and appears in Cast.
- [x] Native Author Stamps capture the resolved Participant identifier and current Participant name at import commit; the original source spelling remains only in preserved import data.
- [x] The final review shows Chat title, source filename and SHA-256, Message and Variant counts, every resulting Participant, existing/new/chat-only outcomes, warnings, and duplicate status.
- [x] Exact duplicates require explicit Import another copy confirmation; related-source warnings remain advisory; intentional copies receive independent Chat and artifact identities.
- [x] Commit uses only the exact staged bytes that produced the preview and rejects changed, missing, or expired staging state.
- [x] The managed exact artifact is finalized before the database operation; initial artifact failure creates no database state.
- [x] Chat, requested new Profiles, Participants, Roster membership, Author Stamps, Messages, Variants, canonical archive, report, and artifact metadata commit as one all-or-nothing SQLite operation through public domain seams.
- [x] A staged commit token succeeds at most once; retry after a lost response returns the original successful result rather than creating another Chat.
- [x] Recoverable commit failure preserves the valid preview and resolution choices for retry during the open flow.
- [x] Successful commit opens the new Chat immediately and shows a compact receipt without adding an Imported badge, category, or capability flag.
- [x] Post-commit Participant reassignment is not added; an authorship-resolution mistake is corrected by importing another copy.
- [x] Focused tests cover merge, split, all three resolution outcomes, blank-name confirmation, duplicate Profile names, Author Stamp creation, Roster completeness, exact duplicate confirmation, domain atomicity, idempotent retry, and success navigation.

## Comments

- This ticket consumes the Character System; it must not implement alternate Participant, Profile, Roster, or Author Stamp persistence inside the importer.
