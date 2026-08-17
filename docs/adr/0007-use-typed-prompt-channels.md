# Use typed Participant prompt channels

The Participant Prompt will preserve four distinct prompt channels: Identity, Scenario, System Instruction, and Post-History Instruction. Version one will compile these channels in a fixed server-owned order rather than flattening them into one instruction or reproducing SillyTavern's configurable prompt machinery.

The canonical version-one order is System Instruction, Identity, Scenario, Example Dialogue, Conversation history, then Post-History Instruction.

Prompt assembly resolves each current Conversation-local Participant Prompt for every Generation. A Participant Prompt is a full fork seeded from an Actor Profile's Master Prompt, so later Profile edits do not change it.

Every Generation includes the active human-controlled and model-controlled Participants' Identity blocks and the selected Conversation history. Only the currently model-controlled Participant contributes System Instruction, Scenario, Example Dialogue, and Post-History Instruction. Swapped-out Roster Participants contribute no prompt channels unless selected history contains their Messages.

Participant prompt channels and Example Dialogue are already Conversation-local and have no additional shadow override layer. Further prompt customization is deferred to the future Prompt Manager.

Participant Prompts may be edited at any point in the Conversation, including while sibling Variants are generating. Each new Generation compiles from the latest saved prompts; active Generations retain the Prompt Plan they captured when they started.

A Prompt Manager is intentionally deferred, not excluded. Prompt assembly will retain stable named blocks so a future manager can arrange them without changing Participant storage or moving prompt authority into the client.

World Info and lorebook scanning are also deferred. Version one has no dynamic context activation engine beyond its Actor blocks, Example Dialogue, and selected Conversation history.
