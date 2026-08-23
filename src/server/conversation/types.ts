// Public contract of the deep Conversation seam. The module owns Cast,
// Control, Messages, Variants, authorship, and derived capabilities;
// callers see only these types plus command execution outcomes.

export interface ConversationDataEntry {
	namespace: string;
	key: string;
	value: string;
}

// A complete Conversation-local identity Definition. Structurally identical
// to a library Definition so application workflows can copy either direction
// without translation, while this seam stays independent of the library.
export interface ParticipantDefinitionPrompt {
	systemInstruction: string;
	identity: string;
	scenario: string;
	exampleDialogue: string;
	postHistoryInstruction: string;
}

export interface ParticipantDefinition {
	name: string;
	prompt: ParticipantDefinitionPrompt;
	openings: readonly string[];
}

export interface CastParticipantSnapshot {
	id: number;
	position: number;
	name: string;
	prompt: ParticipantDefinitionPrompt;
	openings: readonly string[];
	// Immutable provenance: the Character this Participant forked, if any.
	sourceCharacterId: number | null;
}

export interface ConversationControlSnapshot {
	humanParticipantId: number | null;
	modelParticipantId: number | null;
}

// Derived, never stored. A Conversation is playable only when two distinct
// Cast Participants occupy the human and model seats.
export interface ConversationCapabilities {
	compose: CapabilityAvailability;
	generate: CapabilityAvailability;
	swipe: CapabilityAvailability;
}

export interface CapabilityAvailability {
	available: boolean;
	reason: CapabilityBlockReason | null;
}

export type CapabilityBlockReason = "conversation-not-playable";

export interface AuthorStampSnapshot {
	participantId: number | null;
	capturedName: string | null;
}

// The human/model pair active when native generation began. Imported
// Messages carry no fabricated pair.
export interface HistoricalControlSnapshot {
	humanParticipantId: number;
	modelParticipantId: number;
}

export interface ConversationVariantSnapshot {
	id: number;
	position: number;
	content: string;
	timestamp: string;
	selected: boolean;
	data: ConversationDataEntry[];
}

export interface ConversationMessageSnapshot {
	id: number;
	position: number;
	timestamp: string;
	author: AuthorStampSnapshot | null;
	historicalContext: HistoricalControlSnapshot | null;
	variants: ConversationVariantSnapshot[];
	data: ConversationDataEntry[];
}

export interface ConversationSnapshot {
	id: number;
	name: string;
	revision: number;
	cast: CastParticipantSnapshot[];
	control: ConversationControlSnapshot;
	playable: boolean;
	capabilities: ConversationCapabilities;
	messages: ConversationMessageSnapshot[];
	data: ConversationDataEntry[];
}

export type ConversationDataScope =
	| { type: "conversation" }
	| { type: "message"; messageId: number }
	| { type: "variant"; messageId: number; variantId: number };

export type ConversationAction =
	| {
			type: "create-message";
			timestamp: string;
			variantContents: readonly string[];
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
			scope: ConversationDataScope;
			namespace: string;
			key: string;
			value: string;
	  }
	| {
			type: "delete-data";
			scope: ConversationDataScope;
			namespace: string;
			key: string;
	  };

export interface ConversationCommand {
	conversationId: number;
	expectedRevision: number;
	action: ConversationAction;
}

export interface ConversationModule {
	create(input: ConversationCreationInput): ConversationSnapshot;
	getSnapshot(conversationId: number): ConversationSnapshot | undefined;
	execute(command: ConversationCommand): ConversationSnapshot;
}

export interface ConversationCreationVariant {
	content: string;
	timestamp: string;
	selected: boolean;
	data?: readonly ConversationDataEntry[];
}

export interface ConversationCreationMessage {
	timestamp: string;
	variants: readonly ConversationCreationVariant[];
	data?: readonly ConversationDataEntry[];
}

// One ordered Cast entry. Either an ad-hoc complete Definition or the
// already-resolved fork of a Character (with immutable provenance).
export interface ConversationParticipantSeed {
	definition: ParticipantDefinition;
	sourceCharacterId?: number | undefined;
}

// Seats reference Cast entries by their zero-based seed order. The seats
// must be distinct; native creation assigns both.
export interface ConversationControlSeed {
	human: number;
	model: number;
}

export interface ConversationCreationInput {
	name: string;
	participants?: readonly ConversationParticipantSeed[];
	control?: ConversationControlSeed | undefined;
	messages?: readonly ConversationCreationMessage[];
	data?: readonly ConversationDataEntry[];
	// Base time for Conversations whose history does not carry timestamps.
	createdAt?: string | undefined;
}
