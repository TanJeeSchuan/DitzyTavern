# Separate Participant identity from Control

Character and persona are not separate Conversation roles. Both become Participant: the same Conversation-local identity and prompt model, with human or model Control assigned independently.

Version-one Conversations retain a Roster of every Conversation-local Participant used there and assign two distinct Roster Participants to active Control seats: one human and one model. Reassigning either seat retains the displaced Participant, including its edited Participant Prompt, so it can be selected again. This is a crude group-chat foundation without simultaneous multi-model turns or multi-user collaboration.

Both seats are required invariants. Conversation creation atomically adds at least two distinct Participants and assigns both seats; commands may reassign them but may never leave either seat empty or assign the same Participant to both.

Stored Messages retain Participant authorship through an Author Stamp rather than provider roles. Provider-role mapping for history is derived from the active Control assignment when a Prompt Plan is compiled rather than stored as Message authorship. Messages authored by the currently model-controlled Participant map to `assistant`; Messages by every other active or inactive Roster Participant map to `user`. Each compiled historical message is textually prefixed with its immutable Author Stamp name so inactive speakers remain distinguishable.

Changing either active seat is a revisioned Conversation command and is rejected while a Generation is active. The user must let every Generation finish or stop it before changing which Participant they play or which Participant responds.

Swapping Control does not start a Generation. Speaking remains an explicit send or generate action after the assignment changes.

Adding or assigning a Participant mid-chat also does not insert that Participant's configured opening messages. Opening Variants are a Conversation-creation behavior only, so changing configuration never unexpectedly authors history.
