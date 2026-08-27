// Public contract of the deep Conversation seam. The module owns Cast,
// Control, Messages, Variants, authorship, and derived capabilities;
// callers see only these types plus command execution outcomes.

export interface ConversationDataEntry {
	namespace: string;
	key: string;
	value: string;
}

// JSON values are the only opaque values allowed across server-owned
// persistence seams. Keeping this closed recursive type avoids admitting
// provider classes, credentials, or unserializable runtime values.
export type ConversationJsonValue =
	| string
	| number
	| boolean
	| null
	| readonly ConversationJsonValue[]
	| Readonly<{ [key: string]: ConversationJsonValue }>;

// Conversation-local generation controls. Request Overrides retain separate
// namespaces for each API Format so switching a global Connection Profile
// never transmits settings authored for another wire format.
export interface ConversationGenerationSettings {
	modelId: string;
	temperature: number | null;
	topP: number | null;
	frequencyPenalty: number | null;
	presencePenalty: number | null;
	contextLimit: number;
	responseBudget: number;
	safetyAllowance: number;
	siblingGenerationLimit: number;
	continuationStrategy: "instruction" | "assistant-prefill";
	continuationInstruction: string;
	continuationPrefillSuffix: ContinuationPrefillSuffix;
	requestOverrides: Readonly<{
		"chat-completions": GenerationRequestOverrides;
		responses: GenerationRequestOverrides;
		"anthropic-messages": GenerationRequestOverrides;
	}>;
}

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

// Suffixes are intentionally a closed set. They are request-time formatting
// choices, not authored Conversation content.
export type ContinuationPrefillSuffix = "" | " " | "\n" | "\n\n";

// Older clients may omit the newly introduced Safety allowance. The domain
// fills that omission with the same 500-token default used for new rows.
export type ConversationGenerationSettingsInput = Omit<
	ConversationGenerationSettings,
	"safetyAllowance" | "siblingGenerationLimit" | "continuationStrategy" | "continuationInstruction" | "continuationPrefillSuffix"
> & {
	safetyAllowance?: number | undefined;
	siblingGenerationLimit?: number | undefined;
	continuationStrategy?: "instruction" | "assistant-prefill" | undefined;
	continuationInstruction?: string | undefined;
	continuationPrefillSuffix?: ContinuationPrefillSuffix | undefined;
};

// Narrowing for the on-demand Conversation data read. The filter is
// vocabulary-free: namespace and key strings pass through uninterpreted, so
// the owning domain (the import adapter, etc.) keeps deciding their meaning.
export interface ConversationDataReadFilter {
	// Restrict to one namespace; omitted reads every namespace.
	namespace?: string | undefined;
	// Restrict to an explicit key set; omitted or empty reads every key.
	keys?: readonly string[] | undefined;
}

// The narrow Conversation-scoped data read: the Conversation's name plus
// the (namespace, key) entries matching the filter. The full snapshot is
// the heavy read; this is the deliberate on-demand read for detail
// operations like Import Details provenance.
export interface ConversationDataRead {
	name: string;
	entries: ConversationDataEntry[];
}

// Generic filesystem artifact ownership seed. The metadata row commits
// atomically with the Conversation through the creation seam; the exact
// bytes live outside SQLite under the caller-provided unique managed
// relative path and are never automatically deleted. Identity is unique per
// Conversation by (namespace, key).
export interface ConversationArtifactSeed {
	namespace: string;
	key: string;
	relativePath: string;
	originalFilename: string;
	mediaType: string;
	byteLength: number;
	sha256: string;
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
	// A provisional target is server-owned execution state. It is exposed in
	// the snapshot so a reloaded workspace can render the target from
	// authoritative storage instead of a browser-local text accumulator.
	activeGeneration: ActiveGenerationSnapshot | null;
	// All server-owned targets at the active response position. The singular
	// field above remains a compatibility shorthand for the first target;
	// clients that support parallel siblings use this complete list.
	activeGenerations: ActiveGenerationSnapshot[];
	messages: ConversationMessageSnapshot[];
	data: ConversationDataEntry[];
}

// One lightweight Variant in a paginated history read. Heavy provenance
// (generation IDs, reasoning, signatures, and other scoped data) is
// deliberately absent: it loads only through deliberate detail operations,
// never as part of ordinary Chat reading.
export interface ChatHistoryVariant {
	id: number;
	position: number;
	content: string;
	timestamp: string;
	// The source-selected Swipe initializes the selected Variant at commit;
	// afterwards this reflects the persisted native selection only.
	selected: boolean;
}

// Stable Participant identity needed to render one Message: the immutable
// Author Stamp name plus the current active-Cast state. No prompts,
// openings, provenance, or editable Definition content is included.
export interface ChatHistoryMessage {
	id: number;
	position: number;
	timestamp: string;
	// Immutable Author Stamp created from the resolved Participant name at
	// commit; no source Writer or role flag has any special treatment.
	author: AuthorStampSnapshot | null;
	// The model Control captured when this Message was generated. This small
	// capability hint lets a client keep Continue available after Control has
	// moved to another Participant without exposing prompt or provenance data.
	modelParticipantIdAtCreation?: number | null;
	// Derived from the selected Variant's visible text or private reasoning;
	// no reasoning payload crosses the ordinary history boundary.
	continuable?: boolean;
	// Variant order is preserved exactly as stored; empty and duplicate
	// variants remain separate positions with their exact content.
	variants: ChatHistoryVariant[];
}

// The normal Chat read model for reading history: stable chronological
// pages of native Messages with the lightweight Participant identity needed
// for rendering. Exact artifact bytes, the canonical archive text,
// reasoning, signatures, and other heavy provenance are excluded and only
// load through deliberate detail operations.
export interface ChatHistoryPage {
	conversationId: number;
	name: string;
	revision: number;
	// Active Cast identity only (stable id, position, current name).
	cast: { id: number; position: number; name: string }[];
	// Stable chronological paging state: page 1 is the latest window of the
	// position-ordered Message sequence; later pages reach further back into
	// older history, never unstable or derived orderings.
	page: {
		// 1-based page number actually served, bounded to the available range.
		index: number;
		pageSize: number;
		totalMessages: number;
		totalPages: number;
		hasOlder: boolean;
		hasNewer: boolean;
	};
	messages: ChatHistoryMessage[];
}

export interface ChatHistoryPageRequest {
	// 1-based page within the stable position-ordered chronology, counted
	// backward from the newest Message (page 1 = latest window).
	page?: number;
	// Page size; bounded by the module default and maximum.
	pageSize?: number;
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
	| {
			type: "update-generation-settings";
			settings: ConversationGenerationSettingsInput;
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
	getGenerationSettings(
		conversationId: number,
	): ConversationGenerationSettings | undefined;
	// Reads one stable chronological page of the normal Chat history read
	// model. Pages carry the lightweight Participant identity, immutable
	// Author Stamp names, Message chronology, Variant order, and selected
	// Variant state needed for rendering; heavy provenance loads only
	// through deliberate detail operations. Undefined for a missing
	// Conversation.
	readHistory(
		conversationId: number,
		request?: ChatHistoryPageRequest,
	): ChatHistoryPage | undefined;
	// Narrow on-demand read of Conversation-scoped structured data. Returns
	// the Conversation's name and its (namespace, key) entries, optionally
	// filtered by namespace and/or keys. Undefined for a missing
	// Conversation; a present Conversation with no matching entries returns
	// an empty entries array. Vocabulary-free: namespace and key strings pass
	// through uninterpreted, so the owning domain keeps the meaning.
	readConversationData(
		conversationId: number,
		filter?: ConversationDataReadFilter,
	): ConversationDataRead | undefined;
	// Deliberate detail reads. Active inspection is available only while the
	// server-owned row is retained; compact Variant provenance survives that
	// cleanup and is loaded separately from ordinary history.
	readActiveGenerationDetails(
		conversationId: number,
		generationId: number,
	): ActiveGenerationDetails | undefined;
	readVariantDetails(
		conversationId: number,
		messageId: number,
		variantId: number,
	): VariantDetails | undefined;
	execute(command: ConversationCommand): ConversationSnapshot;
	// Server-side commit of a finished current Generate; see
	// CommitGenerationInput. Not a client-submitted command.
	commitGeneration(input: CommitGenerationInput): ConversationSnapshot;
	// Server-owned Send lifecycle. Acceptance creates the ordinary human
	// Message and provisional model target in one revisioned transaction;
	// terminal transitions resolve or remove only that target.
	acceptTailGeneration(
		input: AcceptTailGenerationInput,
	): AcceptedTailGeneration;
	resolveTailGeneration(
		input: ResolveTailGenerationInput,
	): ConversationSnapshot;
	removeTailGeneration(
		input: RemoveTailGenerationInput,
	): ConversationSnapshot;
	stopGeneration(input: StopGenerationInput): ConversationSnapshot;
	acceptContinuationGeneration(
		input: AcceptContinuationGenerationInput,
	): AcceptedContinuationGeneration;
	checkpointGeneration(input: CheckpointGenerationInput): void;
	acceptSiblingGeneration(
		input: AcceptSiblingGenerationInput,
	): AcceptedSiblingGeneration;
	resolveSiblingGeneration(
		input: ResolveSiblingGenerationInput,
	): ConversationSnapshot;
	removeSiblingGeneration(
		input: RemoveSiblingGenerationInput,
	): ConversationSnapshot;
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
	provenance?: ConversationDataEntry | undefined;
	data?: readonly ConversationDataEntry[] | undefined;
}

export interface ActiveGenerationSnapshot {
	generationId: number;
	messageId: number;
	variantId: number;
	startedAt: string;
}

// Deliberate, on-demand read of one server-owned Active Generation. The
// captured plan and omitted history are intentionally absent from ordinary
// Conversation snapshots and history pages; they exist only while the
// active/replay lifecycle retains the generation row.
export interface ActiveGenerationDetails {
	conversationId: number;
	generationId: number;
	messageId: number;
	variantId: number;
	startedAt: string;
	status: "active";
	intent: ConversationJsonValue;
	participants: {
		human: { id: number; name: string };
		model: { id: number; name: string };
	};
	promptPlan: ConversationJsonValue;
	historyRoles: ConversationJsonValue;
	generationSettings: ConversationJsonValue;
	connection: ConversationJsonValue;
	budget: {
		tokenEstimate: number | null;
		responseBudget: number | null;
		safetyAllowance: number | null;
		contextLimit: number | null;
		totalRequiredTokens: number | null;
		omittedHistory: ConversationJsonValue;
	};
	checkpoint: {
		content: string;
		reasoning: string;
		latestEventId: number;
		checkpointedAt: string | null;
	};
}

// Compact terminal provenance is the only Generation detail that survives
// Active Generation cleanup. It has a positive allow-list by design: no
// request overrides, URLs, headers, credentials, or raw provider payloads.
export interface GenerationProvenance {
	connectionProfileId: number | null;
	connectionSettingsRevision: number | null;
	modelBackend: string | null;
	adapter: string | null;
	modelId: string | null;
	generationSettings: {
		temperature: number | null;
		topP: number | null;
		frequencyPenalty: number | null;
		presencePenalty: number | null;
		contextLimit: number | null;
		responseBudget: number | null;
		safetyAllowance: number | null;
		siblingGenerationLimit: number | null;
		continuationStrategy: "instruction" | "assistant-prefill" | null;
		continuationInstruction: string | null;
		continuationPrefillSuffix: "" | " " | "\n" | "\n\n" | null;
	};
	usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
	finishReason: "stop" | "length" | "other" | null;
	status: "complete" | "length-limited" | "interrupted";
	interruptionCause: string | null;
}

// On-demand details for a terminal Variant. Reasoning and arbitrary data
// rows remain outside this contract; Generation provenance is compact and
// safe while the normal history read stays lightweight.
export interface VariantDetails {
	conversationId: number;
	messageId: number;
	variantId: number;
	content: string;
	timestamp: string;
	author: AuthorStampSnapshot | null;
	historicalContext: HistoricalControlSnapshot | null;
	provenance: GenerationProvenance | null;
}

// Captured, provider-neutral input stored with an Active Generation. The
// domain treats the plan/settings/connection values as opaque JSON so this
// seam never imports provider protocol types.
export interface AcceptTailGenerationInput {
	conversationId: number;
	expectedRevision: number;
	timestamp: string;
	humanContent: string;
	// A retry may point at the already accepted trailing human Message. When
	// omitted, acceptance creates one in the same transaction.
	reuseHumanMessageId?: number | undefined;
	humanParticipantId: number;
	modelParticipantId: number;
	capturedHumanName?: string | undefined;
	capturedModelName: string;
	promptPlan: ConversationJsonValue;
	// Active-only budget/omission diagnostics. Older direct callers may omit
	// this field; workflow callers always capture it before acceptance.
	promptInspection?: ConversationJsonValue | undefined;
	historyRoles: readonly ("human" | "model" | null)[];
	generationSettings: ConversationJsonValue;
	connection: ConversationJsonValue;
	generationIntent?: ConversationJsonValue | undefined;
	provenance?: ConversationDataEntry | undefined;
}

export interface AcceptedTailGeneration {
	generationId: number;
	humanMessageId: number;
	modelMessageId: number;
	provisionalVariantId: number;
	conversation: ConversationSnapshot;
}

export interface ResolveTailGenerationInput {
	conversationId: number;
	generationId: number;
	timestamp: string;
	content: string;
	reasoning?: string | undefined;
	data?: readonly ConversationDataEntry[] | undefined;
}

export interface RemoveTailGenerationInput {
	conversationId: number;
	generationId: number;
}

// Explicit Stop is a server-owned lifecycle transition. The checkpoint is
// read from the Active Generation row, so a client cannot forge partial
// output or target another Conversation's Generation.
export interface StopGenerationInput {
	conversationId: number;
	generationId: number;
	timestamp?: string | undefined;
}

// Continuation acceptance creates only the model-authored provisional target.
// The current human seat remains part of the captured historical pair, but
// there is deliberately no Human-authored Message for this lifecycle.
export interface AcceptContinuationGenerationInput {
	conversationId: number;
	expectedRevision: number;
	timestamp: string;
	precedingMessageId: number;
	precedingVariantId: number;
	humanParticipantId: number;
	modelParticipantId: number;
	capturedHumanName?: string | undefined;
	capturedModelName: string;
	promptPlan: ConversationJsonValue;
	promptInspection?: ConversationJsonValue | undefined;
	historyRoles: readonly ("human" | "model" | null)[];
	generationSettings: ConversationJsonValue;
	connection: ConversationJsonValue;
	generationIntent?: ConversationJsonValue | undefined;
	provenance?: ConversationDataEntry | undefined;
}

export interface AcceptedContinuationGeneration {
	generationId: number;
	modelMessageId: number;
	provisionalVariantId: number;
	conversation: ConversationSnapshot;
}

// Sibling acceptance creates a Provisional Variant on an existing Message.
// `priorVariantId` lets an empty failure restore the selection that was
// visible before this attempt, without overwriting a later user selection.
export interface AcceptSiblingGenerationInput {
	conversationId: number;
	messageId: number;
	timestamp: string;
	humanParticipantId: number;
	modelParticipantId: number;
	capturedHumanName?: string | undefined;
	capturedModelName: string;
	promptPlan: ConversationJsonValue;
	promptInspection?: ConversationJsonValue | undefined;
	historyRoles: readonly ("human" | "model" | null)[];
	generationSettings: ConversationJsonValue;
	connection: ConversationJsonValue;
	generationIntent?: ConversationJsonValue | undefined;
	provenance?: ConversationDataEntry | undefined;
}

export interface AcceptedSiblingGeneration {
	generationId: number;
	messageId: number;
	provisionalVariantId: number;
	priorVariantId: number | null;
	conversation: ConversationSnapshot;
}

export interface ResolveSiblingGenerationInput {
	conversationId: number;
	generationId: number;
	timestamp: string;
	content: string;
	reasoning?: string | undefined;
	data?: readonly ConversationDataEntry[] | undefined;
}

export interface RemoveSiblingGenerationInput {
	conversationId: number;
	generationId: number;
}

// Checkpointing is mutable execution state, not a Conversation edit. The
// latest event position is monotonic so a delayed write cannot regress a
// crash-recovery boundary.
export interface CheckpointGenerationInput {
	conversationId: number;
	generationId: number;
	content: string;
	reasoning?: string | undefined;
	latestEventId?: number | undefined;
	timestamp?: string | undefined;
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
	provenance?: ConversationDataEntry | undefined;
	data?: readonly ConversationDataEntry[] | undefined;
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
	// Filesystem artifact metadata committed with the Conversation. The
	// physical bytes themselves are placed by the caller before creation
	// and are never part of ordinary Conversation snapshots.
	artifacts?: readonly ConversationArtifactSeed[];
	// Base time for Conversations whose history does not carry timestamps.
	createdAt?: string | undefined;
}
