# Separate Characters, Participants, and Message authorship

A Character is an optional reusable library source that owns a complete Definition — a normalized nonblank name, a typed Prompt, and ordered openings — and seeds a Conversation-local Participant. The Participant receives a full independent copy of the Definition rather than a live override layer; Character edits and deletion do not rewrite or invalidate existing Conversations. Once used, the Participant remains in its Conversation's Cast even when it occupies neither Control seat.

Each Message stores an inline Author Stamp containing the stable Participant identifier and the name captured when the Message was created. A Message may also capture the human/model Control pair that supplied its historical generation context; imported history may omit that pair when the source cannot establish it. There is no full Character snapshot per Message.

Version one provides no reset, synchronization, merge, or rebase from a Character Definition after the Participant fork has been created.

Cast selection and Character creation are distinct operations. Selecting an existing Cast Participant reuses its stable identity and Conversation-local edits. Adding from the Character Library always creates a new Participant and a full copied Definition, even when the same Character previously seeded another Cast member. Character provenance is never an identity or deduplication key.

An unseated Participant may be removed from the Cast after explicit confirmation. An unreferenced Participant is hard-deleted; a Participant still referenced by an Author Stamp or historical Control pair becomes a hidden, nonrestorable Participant Tombstone retaining stable identity, final name, Conversation identity, and Character provenance while its Definition is stripped. Existing Messages keep their captured attribution, historical sibling generation becomes unavailable when the removed Definition is required, and re-adding the same Character creates a new Participant with a new stable identifier.

Deleting a Character leaves every existing Participant fork unchanged. An unreferenced Character is hard-deleted; a Character still referenced by Participant provenance becomes a hidden, nonrestorable Character Tombstone that keeps its stable identifier and final name while stripping its Definition and Openings. Provenance on existing Participants is never cleared, and an already-tombstoned Character is collected only after its final provenance reference disappears.

Characters are optional conveniences rather than prerequisites. Any Cast Participant may be created ad hoc inside a Conversation; saving it as a Character later copies its complete current Definition into a new Character without changing or relinking the existing Participant.

Renaming a Participant affects its future prompt assembly and Author Stamps. Existing Messages retain the names captured in their immutable stamps, including when their content is edited later.

Participant and Character Tombstones exist only while retained references require their stable identities. Participant cleanup belongs to the Conversation lifecycle; when that cleanup releases the final provenance reference, it invokes the Character Library's narrow tombstone collector in the same transaction rather than relying on a general business-rule trigger.
