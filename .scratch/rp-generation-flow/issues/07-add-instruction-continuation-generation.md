# 07 — Add instruction-based Continuation Generation

**What to build:** Give users a Continue action that asks for more writing without adding an empty human turn or rewriting completed output. Instruction continuation should create a new ordinary model-authored Message using current Control and an inspectable provider-neutral continuation intent.

**Blocked by:** 02 — Budget Prompt Plans with tokenx; 03 — Send through provisional Tail Generation.

**Status:** complete

- [x] Conversation Generation Settings persist a Continuation strategy and required editable Continuation instruction, with instruction as the default strategy.
- [x] Continue is available only when selected history ends with a terminal model-authored Message, the Conversation is playable, and no conflicting Active Generation exists.
- [x] The interface identifies the Participant currently holding model Control before Continue starts.
- [x] Continue preflight uses the complete Selected narrative path, current controlled pair, Generation intent, response budget, and Safety allowance.
- [x] Acceptance creates a new ordinary model-authored Message, Provisional Variant, and Active Generation without a Human-authored Message.
- [x] The new Message uses current model Control even when another Participant authored the preceding Message.
- [x] The Prompt Plan exposes continuation intent and the exact editable Continuation instruction without adding a synthetic history Message.
- [x] Complete, length-limited, and interrupted Variants with visible Content may be continued.
- [x] Reasoning-only terminal Variants may use instruction continuation while Reasoning Content remains excluded from ordinary later history.
- [x] Continued output resolves through the same server-owned events, checkpoints, cleanup, and provenance as other Tail Generations.
- [x] Continued Messages render and behave as normal separate Messages with ordinary editing, Swipes, deletion, and details.
- [x] Length-limited completion never triggers Continue automatically.
