# Separate Actor Profiles, Participants, and Message authorship

An Actor Profile is an optional reusable library source that owns a Master Prompt and seeds a Conversation-local Participant. The Participant receives a full Participant Prompt fork rather than a live override layer; Profile edits and deletion do not rewrite or invalidate existing Conversations. Once used, the Participant remains in its Conversation's Roster even when it occupies neither active Control seat.

Each Message stores only an inline Author Stamp containing the stable Participant identifier and the name captured when the Message was created. There is no full Actor Record or prompt snapshot per Message; optional attribution fields may be added through later migrations without fabricating values for older history.

Version one provides no reset, synchronization, merge, or rebase operation from a Master Prompt after the Participant Prompt fork has been created.

Roster selection and Profile creation are distinct operations. Selecting an existing Roster Participant reuses its stable identity and Conversation-local edits. Adding from the Actor Profile library always creates a new Participant and full Prompt fork, even when the same Profile previously seeded another Roster member. Profile provenance is never an identity or deduplication key.

An inactive Participant may be permanently removed from the Roster after explicit confirmation. Removal deletes that Conversation-local Participant Prompt and configuration but does not alter historical Messages, whose inline Author Stamps remain sufficient attribution. It does not affect the source Actor Profile. Adding the same Profile later creates a new Participant with a new stable identifier.

Deleting an Actor Profile permanently removes only that library source. Existing Participants and Participant Prompts remain unchanged, and any optional provenance link to the deleted Profile is cleared.

Actor Profiles are optional conveniences rather than prerequisites. Any Roster Participant may be created ad hoc inside a Conversation; saving it as an Actor Profile later copies its name and Participant Prompt into a new Master Prompt without changing or relinking the existing Participant.

Renaming a Participant affects its future prompt assembly and Author Stamps. Existing Messages retain the names captured in their immutable stamps, including when their content is edited later.
