// ==[HUMAN APPROVED]== Closed override key families shared by the server merge and the client
// notices. Both sides must agree on which keys the Chat Completions request
// builder manages: a key added here changes the wire behavior and the editor
// explanation together, so the sets live in one place instead of drifting.

// ==[HUMAN APPROVED]== The four first-class Sampling keys an override can collide with. The
// server merges overrides last into the provider request, so an override key
// with the same wire name replaces the Sampling value.
export const FIRST_CLASS_SAMPLING_WIRE_KEYS = [
	"temperature",
	"top_p",
	"frequency_penalty",
	"presence_penalty",
] as const satisfies readonly string[];

// ==[HUMAN APPROVED]== Request-structure fields the Chat Completions merge skips because the app
// owns them: messages are built from the Prompt Plan, the model comes from
// Generation Settings, streaming is the transport mode, and n is managed by
// the adapter.
export const STRUCTURAL_CHAT_COMPLETIONS_WIRE_KEYS = [
	"messages",
	"model",
	"stream",
	"n",
] as const satisfies readonly string[];

// ==[HUMAN APPROVED]== Output-limit keys the Chat Completions merge skips and re-derives from the
// Conversation response budget (see the Connection Profile's output-token
// representation).
export const OUTPUT_LIMIT_CHAT_COMPLETIONS_WIRE_KEYS = [
	"max_tokens",
	"max_completion_tokens",
] as const satisfies readonly string[];
