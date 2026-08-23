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
	// Derived display name of the provenance Character, from the Library
	// row alone (never re-derived from Definitions or synchronization).
	sourceCharacterName: string | null;
	// Derived display label disambiguating duplicate names with ordinals;
	// clients never recompute name identity from internal identifiers.
	duplicateLabel: string;
	// Derived removal eligibility and impact: seated Participants are
	// protected, so only unseated Participants can be removed (removal itself
	// is a separate confirmed action). For eligible Participants the derived
	// deletion mode and affected-generation count power the confirmation
	// presentation before any command is sent.
	removal: ParticipantRemovalEligibility;
}

// Derived, never stored. A seated Participant is ineligible for removal
// until Control changes; unseated Participants are eligible. The impact is
// part of the same derived answer: deletion mode decides the confirmation
// wording (hard delete versus tombstone) and affected-generation count
// states how many Messages lose future sibling Variant generation.
export type ParticipantRemovalBlockReason = "control-assigned";

// Derived, never stored: whether removal hard-deletes the Participant or
// reduces it to a nonrestorable tombstone because a Message still refers to
// it. Null only for ineligible (seated) Participants.
export type ParticipantDeletionMode = "hard-delete" | "tombstone";

export interface ParticipantRemovalEligibility {
	eligible: boolean;
	reason: ParticipantRemovalBlockReason | null;
	// Null while the Participant is seated (ineligible); derived otherwise.
	deletionMode: ParticipantDeletionMode | null;
	// Messages currently able to generate a new sibling Variant that would
	// lose that ability when this Participant is removed. Zero for seated
	// Participants and for unreferenced eligible ones.
	affectedGenerationCount: number;
}

// Derived, never stored. A Conversation is playable only when two distinct
// Cast Participants occupy the human and model seats; Control validity is
// the same rule stated explicitly so clients do not reproduce it.
export type ControlValidityReason =
	| "missing-seat"
	| "seats-not-distinct"
	| "seat-not-in-cast";

export interface ConversationControlValidity {
	valid: boolean;
	reason: ControlValidityReason | null;
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

// Derived, never stored. Whether a new sibling Variant may be generated for
// one Message. Conversation playability gates every play action; without a
// captured historical Control pair — or when a required historical
// Participant no longer has a usable Definition — sibling generation is
// denied with the typed reason while existing Variants remain selectable and
// editable. Discriminated on `eligible` so code never fabricates a reason
// for an ineligible Message (or a reason for an eligible one).
export type MessageSwipeBlockReason =
	| "conversation-not-playable"
	| "missing-historical-context"
	| "historical-participant-unavailable";

export type MessageSwipeEligibility =
	| { eligible: true; reason: null }
	| { eligible: false; reason: MessageSwipeBlockReason };

export interface AuthorStampSnapshot {
	participantId: number | null;
	capturedName: string | null;
	// Derived at snapshot time, never stored: whether the authoring
	// Participant is still an active Cast member. Historical Messages keep
	// displaying the captured name with a no-longer-in-Cast state after the
	// Participant is removed. False for preservation records with no
	// resolved author as well as for removed Participants.
	inCast: boolean;
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
	// Derived, never stored: whether a new sibling Variant (targeted Swipe)
	// may be generated for this Message from its captured historical pair.
	swipe: MessageSwipeEligibility;
	variants: ConversationVariantSnapshot[];
	data: ConversationDataEntry[];
}

export interface ConversationSnapshot {
	id: number;
	name: string;
	revision: number;
	cast: CastParticipantSnapshot[];
	control: ConversationControlSnapshot;
	// Derived, never stored: both seats set, distinct, and in the Cast.
	controlValidity: ConversationControlValidity;
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
	  }
	// Cast management: appends a new Participant with a complete local
	// Definition (ad-hoc, or an already-resolved Character fork carrying
	// immutable provenance). Appended at the next stable Cast position and
	// never inserts history.
	| {
			type: "add-participant";
			definition: ParticipantDefinition;
			sourceCharacterId?: number | undefined;
	  }
	// Local Definition edits with separate semantic Apply actions. Never
	// touch the source Character, existing Messages, or their stamps.
	| { type: "rename-participant"; participantId: number; name: string }
	| {
			type: "replace-participant-prompt";
			participantId: number;
			prompt: ParticipantDefinitionPrompt;
	  }
	| {
			type: "replace-participant-openings";
			participantId: number;
			openings: readonly string[];
	  }
	// Assigns one Control seat to a Cast Participant. Selecting the opposite
	// seat's occupant swaps both seats atomically; selecting an unseated
	// Participant replaces only the chosen seat. Seats are never cleared.
	| { type: "assign-control"; seat: "human" | "model"; participantId: number }
	// Removes an unseated Participant after confirmation. Seated Participants
	// are protected with the typed not-removable outcome. Removing an
	// unreferenced Participant hard-deletes it; a Participant still referred
	// to by Messages (Author Stamp or historical Control pair) is reduced to
	// a nonrestorable tombstone and garbage-collected once its final
	// reference disappears.
	| { type: "remove-participant"; participantId: number };

export interface ConversationCommand {
	conversationId: number;
	expectedRevision: number;
	action: ConversationAction;
}

export interface ConversationModule {
	create(input: ConversationCreationInput): ConversationSnapshot;
	getSnapshot(conversationId: number): ConversationSnapshot | undefined;
	execute(command: ConversationCommand): ConversationSnapshot;
	// Server-side commit of a finished current Generate; see
	// CommitGenerationInput. Not a client-submitted command.
	commitGeneration(input: CommitGenerationInput): ConversationSnapshot;
	// Server-side commit of a finished targeted Swipe (sibling Variant
	// generation); see CommitSiblingVariantInput. Like commitGeneration, it
	// captures at generation start and commits unguarded by the revision so
	// legitimate concurrent edits land without rewriting the in-flight plan.
	commitSiblingVariant(input: CommitSiblingVariantInput): ConversationSnapshot;
}

// Server-side commit of a finished targeted Swipe. The sibling workflow
// captured the Prompt Plan from the target Message's historical pair at
// generation start; this operation appends the returned content as a new
// selected sibling Variant without touching current Control or the Message's
// immutable Author Stamp.
export interface CommitSiblingVariantInput {
	conversationId: number;
	messageId: number;
	timestamp: string;
	content: string;
}

// The generation workflow captures these values at generation start; the
// module validates the pair against the Cast and persists the Message with
// the immutable Author Stamp and historical Control pair exactly as
// captured. The author is always the model Participant of the pair.
export interface CommitGenerationInput {
	conversationId: number;
	timestamp: string;
	content: string;
	authorParticipantId: number;
	capturedAuthorName: string;
	humanParticipantId: number;
	modelParticipantId: number;
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
	// Immutable Author Stamp for explicit history: references the authoring
	// Participant by its zero-based seed order (see ConversationParticipantSeed).
	// Preservation records without a resolved author omit this, mirroring the
	// null stamp allowed by the snapshot. Never carries historical Control
	// context: only native generation captures a pair.
	authorParticipantIndex?: number | undefined;
	data?: readonly ConversationDataEntry[];
}

// One ordered Cast entry. Either an ad-hoc complete Definition or the
// already-resolved fork of a Character (with immutable provenance).
export interface ConversationParticipantSeed {
	definition: ParticipantDefinition;
	sourceCharacterId?: number | undefined;
}

// Seats reference Cast entries by their zero-based seed order. Both seats
// are required for native creation; a partial assignment (one seat only) is
// the narrow incomplete-import exception that reserves the first resolved
// Participant's seat before the missing seat is filled by adding the second.
// No seat at all preserves an empty archive without fabricating Control.
export interface ConversationControlSeed {
	human?: number | undefined;
	model?: number | undefined;
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
