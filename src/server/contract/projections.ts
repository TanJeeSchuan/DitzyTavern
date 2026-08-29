import type { CharacterSnapshot } from "../character-library";
import type { ConversationSnapshot } from "../conversation";

// Adapts the Character seam's immutable snapshot into the transport shape.
export const toCharacterPayload = (character: CharacterSnapshot) => ({
	...character,
	openings: [...character.openings],
});

// Adapts the Conversation seam's immutable snapshot into the summary transport
// shape: the seam returns readonly arrays, while the typed response contract
// declares mutable ones.
export const toConversationSummary = (conversation: ConversationSnapshot) => ({
	id: conversation.id,
	name: conversation.name,
	revision: conversation.revision,
	cast: conversation.cast.map((participant) => ({
		...participant,
		openings: [...participant.openings],
	})),
	control: conversation.control,
	controlValidity: conversation.controlValidity,
	playable: conversation.playable,
	capabilities: conversation.capabilities,
	activeGenerations: conversation.activeGenerations,
});
