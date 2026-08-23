import { api } from "./lib/eden";

// Typed client for the deep Conversation transport adapters: snapshot
// reads, revisioned command execution, and the explicit Character-to-Cast
// workflow. Outcomes mirror the server's typed results so the Cast drawer
// and composer can recover from conflicts without losing local drafts.

export interface ParticipantPrompt {
	systemInstruction: string;
	identity: string;
	scenario: string;
	exampleDialogue: string;
	postHistoryInstruction: string;
}

export interface ParticipantDefinition {
	name: string;
	prompt: ParticipantPrompt;
	openings: string[];
}

export interface CastParticipant {
	id: number;
	position: number;
	name: string;
	prompt: ParticipantPrompt;
	openings: string[];
	sourceCharacterId: number | null;
	sourceCharacterName: string | null;
	duplicateLabel: string;
	removal: { eligible: boolean; reason: "control-assigned" | null };
}

export interface ConversationControl {
	humanParticipantId: number | null;
	modelParticipantId: number | null;
}

export interface ConversationControlValidity {
	valid: boolean;
	reason: "missing-seat" | "seats-not-distinct" | "seat-not-in-cast" | null;
}

export interface ConversationSnapshot {
	id: number;
	name: string;
	revision: number;
	cast: CastParticipant[];
	control: ConversationControl;
	controlValidity: ConversationControlValidity;
	playable: boolean;
	capabilities: {
		compose: { available: boolean; reason: "conversation-not-playable" | null };
		generate: { available: boolean; reason: "conversation-not-playable" | null };
		swipe: { available: boolean; reason: "conversation-not-playable" | null };
	};
	messages: readonly unknown[];
	data: readonly { namespace: string; key: string; value: string }[];
}

export type ConversationAction =
	| {
			type: "create-message";
			timestamp: string;
			variantContents: string[];
			selectedVariantIndex?: number;
			authorParticipantId: number;
	  }
	| { type: "create-variant"; messageId: number; content: string }
	| { type: "select-variant"; messageId: number; variantId: number }
	| { type: "edit-variant"; messageId: number; variantId: number; content: string }
	| { type: "delete-variant"; messageId: number; variantId: number }
	| { type: "delete-message"; messageId: number }
	| {
			type: "put-data";
			scope:
				| { type: "conversation" }
				| { type: "message"; messageId: number }
				| { type: "variant"; messageId: number; variantId: number };
			namespace: string;
			key: string;
			value: string;
	  }
	| {
			type: "delete-data";
			scope:
				| { type: "conversation" }
				| { type: "message"; messageId: number }
				| { type: "variant"; messageId: number; variantId: number };
			namespace: string;
			key: string;
	  }
	| {
			type: "add-participant";
			definition: ParticipantDefinition;
			sourceCharacterId?: number;
	  }
	| { type: "rename-participant"; participantId: number; name: string }
	| {
			type: "replace-participant-prompt";
			participantId: number;
			prompt: ParticipantPrompt;
	  }
	| {
			type: "replace-participant-openings";
			participantId: number;
			openings: string[];
	  }
	| { type: "assign-control"; seat: "human" | "model"; participantId: number };

export type CommandOutcome =
	| { status: "applied"; conversation: ConversationSnapshot }
	| { status: "conflict"; currentConversation: ConversationSnapshot }
	| { status: "not-found" }
	| { status: "not-playable"; reason: string }
	| { status: "invalid"; reason: string }
	| { status: "network" };

export type AddCharacterOutcome =
	| { status: "applied"; conversation: ConversationSnapshot }
	| {
			status: "conflict";
			currentConversation?: ConversationSnapshot;
			currentCharacterName?: string;
	  }
	| { status: "not-found" }
	| { status: "invalid"; reason: string }
	| { status: "network" };

export async function loadConversation(
	conversationId: number,
): Promise<ConversationSnapshot | null> {
	const { data, error } = await api.api.conversations({ id: conversationId }).get();
	if (error !== null && error !== undefined) {
		if (error.status === 404) {
			return null;
		}
		throw new Error(`Unable to load Conversation ${conversationId}`);
	}
	return data ?? null;
}

export async function applyConversationCommand(
	conversationId: number,
	expectedRevision: number,
	action: ConversationAction,
): Promise<CommandOutcome> {
	const { data, error } = await api.api.conversations({ id: conversationId }).commands.post({
		expectedRevision,
		action,
	});
	if (error) {
		// SAFETY: the transport contract declares the typed error union; the
		// discriminated `outcome` field narrows it before any payload access.
		const payload = error.value;
		if (payload.outcome === "conflict") {
			return {
				status: "conflict",
				currentConversation: payload.currentConversation,
			};
		}
		if (payload.outcome === "not-found") {
			return { status: "not-found" };
		}
		if (payload.outcome === "not-playable") {
			return { status: "not-playable", reason: payload.reason };
		}
		if (payload.outcome === "invalid") {
			return { status: "invalid", reason: payload.reason };
		}
		return { status: "network" };
	}
	return { status: "applied", conversation: data.conversation };
}

export async function addCharacterToCast(input: {
	conversationId: number;
	expectedConversationRevision: number;
	characterId: number;
	expectedCharacterRevision: number;
}): Promise<AddCharacterOutcome> {
	const { data, error } = await api.api
		.conversations({ id: input.conversationId })
		.cast.characters.post({
			expectedConversationRevision: input.expectedConversationRevision,
			characterId: input.characterId,
			expectedCharacterRevision: input.expectedCharacterRevision,
		});
	if (error) {
		// SAFETY: the transport contract declares the typed error union; the
		// `outcome` field plus the presence of either authoritative payload
		// narrows which conflict kind was returned.
		const payload = error.value;
		if (payload.outcome === "conflict") {
			if ("currentConversation" in payload) {
				return { status: "conflict", currentConversation: payload.currentConversation };
			}
			return {
				status: "conflict",
				currentCharacterName: payload.currentCharacter.name,
			};
		}
		if (payload.outcome === "not-found") {
			return { status: "not-found" };
		}
		if (payload.outcome === "invalid") {
			return { status: "invalid", reason: payload.reason };
		}
		return { status: "network" };
	}
	return { status: "applied", conversation: data.conversation };
}