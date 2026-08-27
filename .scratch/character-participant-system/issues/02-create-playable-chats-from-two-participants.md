# 02 — Create playable Chats from two Participants

**What to build:** A native New Chat flow in which a user configures distinct human- and model-controlled Participants side by side, using Character forks or ad-hoc Definitions, and receives a playable Conversation with native Cast, Control, authorship, and opening Variants.

**Blocked by:** 01 — Create and edit Characters in the Library.

**Status:** resolved

- [x] Native Chat creation requires two distinct Participant instances before commit and never creates a partially configured native Conversation.
- [x] Either initial Participant may fork an authoritative Character Definition or use an ad-hoc complete Definition, and both Participants may independently fork the same Character.
- [x] A Character fork copies the current Definition and stores immutable source Character identity without source revision, synchronization, reset, refresh, merge, or rebase behavior.
- [x] The Cast stores explicit contiguous positions, and Control assigns one Cast Participant to the human seat and a distinct Cast Participant to the model seat.
- [x] Playability is derived from the two valid Control assignments rather than stored as an independent status flag.
- [x] The initial model Participant's ordered openings become one author-stamped Message with ordered sibling Variants and the first Variant selected; no opening creates no Message.
- [x] Human openings do not create history, and later Participant additions or Control changes do not insert openings.
- [x] Every created Message has immutable authorship containing Participant identity and the name captured at Message creation; all of its Variants share that authorship.
- [x] New Chat UI presents human and model setup side by side, supports Character selection and ad-hoc Definitions, and makes the two Control assignments explicit before commit.
- [x] The Conversation snapshot exposes full initial Cast Definitions, provenance, Control, Messages, authorship, and derived playability through the deep Conversation seam.
- [x] The old shallow Chat-to-Character membership model and obsolete development data are replaced with the Participant model through a generated destructive development migration and symmetric seed/teardown updates.
- [x] Real-SQLite interface tests cover two ad-hoc Participants, two different Character forks, two forks of the same Character, openings, exact authorship, atomic failure, and structural constraints.
- [x] Relevant architecture and product documentation is amended so Writer is an ordinary possible Participant name rather than a privileged identity or Message intent.
