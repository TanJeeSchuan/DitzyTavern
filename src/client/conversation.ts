import { api } from "./lib/eden";
import type { CharacterSnapshot } from "./character-library";

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
	// Derived removal eligibility and impact: the deletion mode names hard
	// delete versus tombstone, and the affected-generation count states how
	// many Messages lose future sibling Variant generation. Clients present
	// these values; they never reconstruct the rules.
	removal: {
		eligible: boolean;
		reason: "control-assigned" | null;
		deletionMode: "hard-delete" | "tombstone" | null;
		affectedGenerationCount: number;
	};
}

export interface ConversationControl {
	humanParticipantId: number | null;
	modelParticipantId: number | null;
}

export interface ConversationControlValidity {
	valid: boolean;
	reason: "missing-seat" | "seats-not-distinct" | "seat-not-in-cast" | null;
}

export interface ConversationGenerationSettings {
	modelId: string;
	temperature: number | null;
	topP: number | null;
	frequencyPenalty: number | null;
	presencePenalty: number | null;
	contextLimit: number;
	responseBudget: number;
	requestOverrides: {
		"chat-completions": GenerationRequestOverrides;
		responses: GenerationRequestOverrides;
		"anthropic-messages": GenerationRequestOverrides;
	};
}

export type GenerationResult =
	| {
			outcome: "applied";
			conversation: ConversationSummary;
			variant: {
				messageId: number;
				variantId: number;
				content: string;
				timestamp: string;
				data: Array<{ namespace: string; key: string; value: string }>;
			};
		}
	| { outcome: "not-found" }
	| { outcome: "not-playable" | "unconfigured" | "failed" | "invalid"; reason: string };

export type GenerationRequestValue =
	| string
	| number
	| boolean
	| null
	| readonly GenerationRequestValue[]
	| Readonly<{ [key: string]: GenerationRequestValue }>;

export type GenerationRequestOverrides = Readonly<
	Record<string, GenerationRequestValue>
>;

// Slim conversational view: the transport never ships Messages or
// per-Conversation data. The story reads through the paginated history
// seam, and heavy provenance loads only through the Import Details
// operations; this view carries the header, Cast, Control, and derived
// playability state the Cast drawer, composer, and setup surface need.
export interface ConversationSummary {
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
			type: "update-generation-settings";
			settings: ConversationGenerationSettings;
	  }
	| {
			type: "add-participant";
			definition: ParticipantDefinition;
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
	| { type: "assign-control"; seat: "human" | "model"; participantId: number }
	// Removes an unseated Participant after confirmation. Seated Participants
	// are protected with the typed not-removable outcome; the impact is
	// shown from the snapshot before this command is sent.
	| { type: "remove-participant"; participantId: number };

// Note: the client-side add-participant action intentionally carries no
// sourceCharacterId. Character-to-Cast forks always go through
// addCharacterToCast (the workflow route), which checks the source
// Character and destination Conversation revisions server-side.

export type CommandOutcome =
	| { status: "applied"; conversation: ConversationSummary }
	| { status: "conflict"; currentConversation: ConversationSummary }
	| { status: "not-found" }
	| { status: "not-playable"; reason: string }
	// A seated Participant cannot be removed; the typed reason comes from the
	// server so clients never reconstruct the seat rule.
	| { status: "not-removable"; reason: string }
	| { status: "invalid"; reason: string }
	| { status: "network" };

export type AddCharacterOutcome =
	| { status: "applied"; conversation: ConversationSummary }
	| {
			status: "conflict";
			currentConversation?: ConversationSummary;
			currentCharacterName?: string;
	  }
	| { status: "not-found" }
	| { status: "invalid"; reason: string }
	| { status: "network" };

export async function loadConversation(
	conversationId: number,
): Promise<ConversationSummary | null> {
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
		if (payload.outcome === "not-removable") {
			return { status: "not-removable", reason: payload.reason };
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

export type SaveParticipantAsCharacterOutcome =
	| { status: "applied"; character: CharacterSnapshot }
	| { status: "conflict"; currentConversation: ConversationSummary }
	| { status: "not-found" }
	| { status: "invalid"; reason: string }
	| { status: "network" };

// Promotes a Conversation-local Participant into a new reusable Character
// through the explicit workflow route. The server checks the expected
// Conversation revision and copies the authoritative server-side
// Participant Definition; the client never submits a Definition copy, so a
// stale one cannot become the new Character's source.
export async function saveParticipantAsCharacter(input: {
	conversationId: number;
	expectedConversationRevision: number;
	participantId: number;
}): Promise<SaveParticipantAsCharacterOutcome> {
	const { data, error } = await api.api
		.conversations({ id: input.conversationId })
		.cast.participants({ participantId: input.participantId })
		.characters.post({
			expectedConversationRevision: input.expectedConversationRevision,
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
		if (payload.outcome === "invalid") {
			return { status: "invalid", reason: payload.reason };
		}
		return { status: "network" };
	}
	return { status: "applied", character: data.character };
}

export async function loadConversationGenerationSettings(
	conversationId: number,
): Promise<ConversationGenerationSettings> {
	const response = await fetch(`/api/conversations/${conversationId}/generation-settings`);
	if (!response.ok) throw new Error("Unable to load Conversation Generation Settings.");
	// SAFETY: the route's response contract is the Conversation Generation
	// Settings shape; this client function is the sole decoder for it.
	return (await response.json()) as ConversationGenerationSettings;
}

export async function generateConversationReply(
	conversationId: number,
): Promise<GenerationResult> {
	const response = await fetch(`/api/conversations/${conversationId}/generate`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	});
	// SAFETY: the route's discriminated response contract is narrowed by the
	// outcome field before callers consume its payload.
	const body = (await response.json()) as GenerationResult;
	return body;
}
