# Separate Characters, Participants, and Message authorship

A Character is an optional reusable library source that owns a complete Definition — a normalized nonblank name, a typed Prompt, and ordered openings — and seeds a Conversation-local Participant. The Participant receives a full independent copy of the Definition rather than a live override layer; Character edits and deletion do not rewrite or invalidate existing Conversations. Once used, the Participant remains in its Conversation's Cast even when it occupies neither Control seat.

Each Message stores only an inline Author Stamp containing the stable Participant identifier and the name captured when the Message was created. There is no full Character snapshot per Message; optional attribution fields may be added through later migrations without fabricating values for older history.

Version one provides no reset, synchronization, merge, or rebase from a Character Definition after the Participant fork has been created.

Cast selection and Character creation are distinct operations. Selecting an existing Cast Participant reuses its stable identity and Conversation-local edits. Adding from the Character Library always creates a new Participant and a full copied Definition, even when the same Character previously seeded another Cast member. Character provenance is never an identity or deduplication key.

An unseated Participant may be permanently removed from the Cast after explicit confirmation. Removal deletes that Conversation-local copy of the Definition but does not alter historical Messages, whose inline Author Stamps remain sufficient attribution. It does not affect the source Character. Re-adding the same Character later creates a new Participant with a new stable identifier.

Deleting a Character leaves every existing Participant fork unchanged. An unreferenced Character is hard-deleted; a Character still referenced by Participant provenance becomes a hidden, nonrestorable tombstone that keeps its stable identifier and final name while stripping its Definition and openings. Provenance on existing Participants is never cleared.

Characters are optional conveniences rather than prerequisites. Any Cast Participant may be created ad hoc inside a Conversation; saving it as a Character later copies its complete current Definition into a new Character without changing or relinking the existing Participant.

Renaming a Participant affects its future prompt assembly and Author Stamps. Existing Messages retain the names captured in their immutable stamps, including when their content is edited later.
