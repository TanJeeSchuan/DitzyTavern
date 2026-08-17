# Model alternative generated replies as Variants

A model-generated Message may retain multiple alternative Variants at the same position in a Conversation. Swiping generates a new Variant instead of destructively regenerating the Message; users can reproduce replacement-style regeneration by generating a Variant and deleting alternatives they no longer want.

Exactly one Variant is selected for each model-generated Message. Only the selected Variant participates in prompt assembly, and switching selection is a revisioned Conversation mutation that preserves all later Messages.

The server may generate a new Variant only for the latest model-generated Message and only while that Message's stamped Participant occupies the active model Control seat. Existing Variants remain selectable and editable regardless of current Control, but another Participant can never generate a Variant under the Message's authorship.

Swiping may start several sibling Generations in parallel for the latest model-generated Message. Every sibling uses the same preceding Conversation history position but independently captures the current Prompt Plan and Generation Settings when it starts. Sending a new Message remains blocked until all sibling Generations finish or are stopped.

A model-generated Message owns all of its Variants and must retain at least one. Deleting the final Variant is forbidden; deleting the Message removes its entire Variant collection.

A provider `finish_reason` of `length` persists the Variant with a distinct `length-limited` outcome and a visible truncation indicator. It is neither silently treated as natural completion nor auto-continued. It does not block subsequent Send, Generate, or Swipe commands, and the Variant retains the raw provider finish reason as compact outcome metadata.

Creating a Conversation atomically establishes its initial Roster and Control assignments, then copies all opening messages from the initially model-controlled Participant into the initial Message as Variants and selects the first deterministically. Those Variants then belong to Conversation history and are not rewritten by later Participant or Actor Profile edits. If no opening messages exist, the otherwise valid Conversation begins with empty history.

Opening messages are used only during Conversation creation. Adding a Participant to the Roster or assigning one to either Control seat mid-chat never inserts an opening Message, mutates history, or starts a Generation. Continuing after a seat change requires an explicit Send or Generate command; a future explicit insertion feature may be added only from demonstrated need.

After the model seat changes, Generate creates a new Message stamped with the newly active model Participant rather than adding a Variant to the previous Participant's Message. If the previous response used the wrong Participant, the explicit replacement flow is to stop any active Generation, delete that Message, change the model seat, and Generate again. Control changes remain rejected until active Generations finish or are stopped.
