# Separate Participant identity from Control

A reusable Character, a Conversation-local Participant, and a Control seat are separate concepts. Any Participant, including one named Writer, may occupy either Control seat; the name or source of a Participant creates no special role.

Version-one Conversations retain an ordered Cast of active Conversation-local Participants and assign two distinct Cast Participants to Control seats: one human and one model. Reassigning either seat retains the displaced Participant, including its edited Definition, so it can be selected again. This is a foundation for later group-chat behavior without introducing active/inactive membership, simultaneous multi-model turns, or multi-user collaboration.

Both seats are required invariants for native Conversation creation and play. Native creation atomically adds at least two distinct Participants and assigns both seats; commands may reassign them but may never clear a seat or assign the same Participant to both.

Imported Chats make one narrow exception: a preservation-oriented import that resolves zero or one source-author group persists as an incomplete Conversation with no Control or a single reserved human seat rather than fabricating identities or failing preservation. Adding the missing Participant fills only the empty seat, preserving any existing assignment, and derives playability automatically; afterwards the Conversation follows the same Control, removal, generation, and Swipe rules as native Conversations.

Stored Messages retain Participant authorship through an Author Stamp rather than provider roles. Selected history enters the provider-neutral Prompt Plan with the immutable captured speaker name; any later provider-role translation is a Model Client concern and cannot reinterpret the stored authorship or current Cast membership.

Changing either active seat is a revisioned Conversation command and is rejected while a Generation is active. The user must let every Generation finish or stop it before changing which Participant they play or which Participant responds.

Swapping Control does not start a Generation. Speaking remains an explicit send or generate action after the assignment changes.

Adding or assigning a Participant mid-chat also does not insert that Participant's configured Openings. Opening Variants are a Conversation-creation behavior only, so changing configuration never unexpectedly authors history.
