import type { CharacterSnapshot } from "../character-library";
import type { ConversationSnapshot } from "../conversation";

// ==[HUMAN APPROVED]== Adapts the Character seam's immutable snapshot into the transport shape.
// The Character Library snapshot keeps its readonly openings declaration
// (owned by the Character Library seam), so the mutable wire copy is built
// here.
export const toCharacterPayload = (character: CharacterSnapshot) => ({
	...character,
	openings: [...character.openings],
});

// ==[HUMAN APPROVED]== Adapts the Conversation seam's deep snapshot into the summary transport
// shape. The Conversation domain types derive from the canonical shared
// schemas (ADR-0032), so Cast, Control, validity, capabilities, and active
// generations already carry the wire shapes and need no per-field copying.
// The projection stays to drop the deliberate deep-only `messages` and
// `data` reads (divergence (b)): heavy reads go through other seams and
// must never ride on a summary response.
export const toConversationSummary = (conversation: ConversationSnapshot) => ({
	id: conversation.id,
	name: conversation.name,
	revision: conversation.revision,
	cast: conversation.cast,
	control: conversation.control,
	controlValidity: conversation.controlValidity,
	playable: conversation.playable,
	capabilities: conversation.capabilities,
	activeGenerations: conversation.activeGenerations,
});
