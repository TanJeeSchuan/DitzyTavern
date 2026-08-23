# Use typed Participant prompt channels

The Participant Prompt will preserve five distinct prompt channels: System Instruction, Identity, Scenario, Example Dialogue, and Post-History Instruction. Version one will compile these channels in a fixed server-owned order rather than flattening them into one instruction or reproducing SillyTavern's configurable prompt machinery.

The canonical version-one order is System Instruction, Identity, Scenario, Example Dialogue, Conversation history, then Post-History Instruction. Example Dialogue is stored as exact raw text and rendered as its own provider-neutral block at that fixed position, so a future Prompt Manager can move it without altering storage.

Prompt assembly resolves each current Conversation-local Participant Prompt for every Generation. A Participant Prompt is a full fork seeded from an Actor Profile's Master Prompt, so later Profile edits do not change it.

Every Generation includes the active human-controlled and model-controlled Participants' Identity blocks and the selected Conversation history. Only the currently model-controlled Participant contributes System Instruction, Scenario, Example Dialogue, and Post-History Instruction. Swapped-out Roster Participants contribute no prompt channels unless selected history contains their Messages.

Participant prompt channels and Example Dialogue are already Conversation-local and have no additional shadow override layer. Further prompt customization is deferred to the future Prompt Manager.

Participant Prompts may be edited at any point in the Conversation, including while sibling Variants are generating. Each new Generation compiles from the latest saved prompts; active Generations retain the Prompt Plan they captured when they started.

A Prompt Manager is intentionally deferred, not excluded. Prompt assembly will retain stable named blocks so a future manager can arrange them without changing Participant storage or moving prompt authority into the client.

World Info and lorebook scanning are also deferred. Version one has no dynamic context activation engine beyond its Actor blocks, Example Dialogue, and selected Conversation history.

## Amendment — Example Dialogue block and owner-relative macros

This amendment records the two decisions that determine how the typed channels render.

- **Example Dialogue placement.** Example Dialogue is a first-class prompt channel with its own provider-neutral block, compiled from the exact stored raw text without rewriting or normalization, and placed between Scenario and Conversation history in the canonical order. Empty Definition blocks are omitted from the rendered plan only; storage always keeps the exact text.
- **Owner-relative macros.** Version one recognizes exactly `{{self}}` and `{{other}}`. When a Prompt field or opening is compiled, `{{self}}` expands to the name of the Participant that owns the Definition or opening being compiled and `{{other}}` expands to the other controlled Participant's name, so the identical Definition renders correctly under either Control assignment. Macros are case-sensitive (`{{SELF}}` is unknown), expanded exactly once in a single left-to-right pass, and their expansion output is never rescanned. A backslash escapes a recognized macro (`\{{self}}` renders `{{self}}` literally). Unknown macros are preserved literally and are reported as prompt-inspection warnings. The same rules apply when compiling Prompt fields and when compiling openings, including the initial greeting.
