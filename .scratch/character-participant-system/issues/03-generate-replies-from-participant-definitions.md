# 03 — Generate replies from Participant Definitions

**What to build:** Current Generate uses the controlled Participants' Definitions to assemble a deterministic prompt and creates a model-authored native Message with all context needed to understand the generation later.

**Blocked by:** 02 — Create playable Chats from two Participants.

**Status:** resolved

- [x] Prompt assembly orders System Instruction, human Identity, model Identity, Scenario, Example Dialogue, selected history, and Post-History Instruction.
- [x] Both controlled Participants contribute Identity, while only the model-controlled Participant contributes the other Definition blocks; empty blocks are omitted only from the rendered plan.
- [x] Example Dialogue is represented as its own provider-neutral prompt block using its exact stored raw text.
- [x] `{{self}}` and `{{other}}` expand relative to the Definition owner, case-sensitively and in one pass, with expansion output left unscanned.
- [x] Escaped recognized macros render literally, while unknown macros remain literal and appear as prompt-inspection warnings.
- [x] Macro behavior applies consistently when compiling Prompt fields and openings and has focused pure compiler coverage in addition to interface behavior tests.
- [x] Generation captures the Prompt Plan, human Participant identity, model Participant identity, and immutable Author Stamp at generation start.
- [x] Concurrent Participant rename or Definition edits do not change an in-flight generation; the next generation uses the updated authoritative state.
- [x] A successful current Generate creates a new Message authored by the Participant occupying model Control at generation start.
- [x] Incomplete or otherwise unplayable Conversations reject Generate with a typed domain result before contacting the model transport.
- [x] Prompt inspection and generated Message presentation expose the agreed participant context without introducing provider vocabulary into the Conversation domain.
- [x] Public-interface tests with real SQLite cover compilation order, exact text, macros, warnings, generation-start capture, authorship, conflicts, and not-playable behavior; transport tests remain narrowly focused.
- [x] The typed prompt-channel decision is amended to record Example Dialogue placement and the agreed owner-relative macro semantics.
