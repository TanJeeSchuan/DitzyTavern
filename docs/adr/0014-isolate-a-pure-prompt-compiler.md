# Isolate a pure Prompt Compiler module

Prompt assembly will live in a pure, deep Prompt Compiler module whose principal interface compiles resolved Participant state, selected Conversation history, generation intent, and budget into a Prompt Plan. The module owns role mapping, named-block ordering, Example Dialogue, truncation, and future Prompt Manager behavior without depending on SQLite, HTTP, SSE, or credentials.

Prompt Compiler tests exercise this interface directly with deterministic inputs and outputs. The compiler runs independently for every Generation, including sibling Variants at the same response position, so mid-chat prompt edits affect later swipes without mutating already active Generations.

The resulting Prompt Plan is provider-neutral: it retains named blocks, normalized Participant-authored history, generation target, and budget rather than exposing a vendor request payload. Provider translation consumes this plan separately.

For the version-one Roster model, history normalization maps Messages by the currently model-controlled Participant to `assistant` and every other Participant to `user`. It prefixes every history item with the immutable name in its Author Stamp. This preserves speaker identity for inactive Roster members without storing provider roles or relying on a provider's optional message-name field.

The compiler first reserves the configured response budget. That Conversation setting is the single output-budget source used by compilation, Inspect Prompts, and Model Client translation; Request Overrides cannot replace its wire representation. Participant prompt channels and the active Post-History Instruction are mandatory and never silently truncated; if they cannot fit, compilation fails clearly. From the remaining budget, recent selected Conversation history outranks Example Dialogue, Example Dialogue is removed before recent history, and the oldest history is removed first.

Because an arbitrary OpenAI-style model identifier does not identify a reliable tokenizer, version one uses one bundled tokenizer only as a Token Estimate. Inspect Prompts labels the result as estimated. The compiler applies a configurable safety margin before the user-supplied context limit, and advanced configuration may disable local budgeting entirely. Version one does not build a tokenizer registry or provider-specific counting service.

The remote endpoint remains authoritative. If its tokenizer still considers a locally budgeted request too large, the Model Client surfaces that provider error without retrying, recompiling, or silently dropping more context.
