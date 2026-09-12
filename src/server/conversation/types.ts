import type { Static } from "@sinclair/typebox";
import type { GenerationJsonValue } from "../../shared/generation-json";
import type {
	GenerationProvenance as SharedGenerationProvenance,
} from "../../shared/generation-provenance";
import type { artifactMetadata } from "../../shared/contract/chat-import";
import type {
	ActiveGenerationDetails as SharedActiveGenerationDetails,
	CapabilityAvailability as SharedCapabilityAvailability,
	CastParticipant as SharedCastParticipant,
	ChatHistoryMessage as SharedChatHistoryMessage,
	ChatHistoryPage as SharedChatHistoryPage,
	ChatHistoryVariant as SharedChatHistoryVariant,
	ConversationAction as SharedConversationAction,
	ConversationCapabilities as SharedConversationCapabilities,
	ConversationControl as SharedConversationControl,
	ConversationControlValidity as SharedConversationControlValidity,
	ParticipantDefinition as SharedParticipantDefinition,
	PromptPlan,
	VariantDetails as SharedVariantDetails,
} from "../../shared/contract/conversation-schema";
import type {
	CanonicalGenerationSettings,
} from "../../shared/contract/generation-settings";
import type { ConversationPromptPreset } from "../../shared/contract/prompt-preset";
import type { MacroVariableWrite } from "../../shared/contract/macro-variables";
import type {
	MacroVariables as SharedMacroVariables,
} from "../../shared/contract/macro-variables";

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
export type ConversationJsonValue = GenerationJsonValue;

export type MacroVariables = SharedMacroVariables;

// Conversation-local generation controls derive from the canonical
// Generation Settings declaration (ADR-0032) instead of restating its
// fields: adding a canonical field changes the domain type, the defaults,
// and the storage adapter together, so the copies cannot drift. Request
// Overrides retain separate namespaces for each API Format so switching a
// global Connection Profile never transmits settings authored for another
// wire format.
export type ConversationGenerationSettings = CanonicalGenerationSettings;

export type {
	GenerationJsonObject as GenerationRequestOverrides,
} from "../../shared/generation-json";

// Suffixes are intentionally a closed set. They are request-time formatting
// choices, not authored Conversation content. The domain alias stays derived
// from the canonical declaration it rides on.
export type ContinuationPrefillSuffix = ConversationGenerationSettings["continuationPrefillSuffix"];

// The update input is the complete canonical declaration: the server is
// authoritative and never accepts omitted client fields. The Conversation
// module still fills defaults when it creates settings server-side, but an
// update command always states every canonical field.
export type ConversationGenerationSettingsInput = CanonicalGenerationSettings;

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
//
// ==[HUMAN APPROVED]== Derived from the canonical shared artifact metadata schema so the
// creation seam and the Chat Import wire contract cannot drift.
export type ConversationArtifactSeed = Static<typeof artifactMetadata>;

// A complete Conversation-local identity Definition. Derived from the
// canonical shared schema (ADR-0032) so it stays structurally identical to a
// library Definition and application workflows can copy either direction
// without translation, while this seam stays independent of the library.
export type ParticipantDefinition = SharedParticipantDefinition;

// The Cast Participant snapshot derives from the canonical wire schema
// (ADR-0032): the transport projection and this seam share one declaration,
// so a derived field added at the boundary automatically appears in the
// snapshot. Its field semantics are documented on the canonical schema:
// immutable Character provenance, derived duplicate labels, and derived
// removal eligibility and impact.
export type CastParticipantSnapshot = SharedCastParticipant;

// Derived, never stored. A seated Participant is ineligible for removal
// until Control changes; unseated Participants are eligible. The impact is
// part of the same derived answer: deletion mode decides the confirmation
// wording (hard delete versus tombstone) and affected-generation count
// states how many Messages lose future sibling Variant generation. All
// three names stay derived from the canonical snapshot so the vocabulary
// cannot drift.
export type ParticipantRemovalEligibility = CastParticipantSnapshot["removal"];

export type ParticipantRemovalBlockReason =
	NonNullable<ParticipantRemovalEligibility["reason"]>;

export type ParticipantDeletionMode =
	NonNullable<ParticipantRemovalEligibility["deletionMode"]>;

// Derived, never stored. A Conversation is playable only when two distinct
// Cast Participants occupy the human and model seats; Control validity is
// the same rule stated explicitly so clients do not reproduce it.
// Control and its derived validity derive from the canonical wire schemas
// (ADR-0032); the playability rule is stated once at the boundary and both
// layers read the same shapes.
export type ConversationControlSnapshot = SharedConversationControl;

export type ConversationControlValidity = SharedConversationControlValidity;

export type ControlValidityReason =
	NonNullable<ConversationControlValidity["reason"]>;

// Derived, never stored. Play-gated capabilities derive from the canonical
// wire schemas (ADR-0032) so a new capability or block reason changes both
// layers together.
export type CapabilityAvailability = SharedCapabilityAvailability;

export type ConversationCapabilities = SharedConversationCapabilities;

export type CapabilityBlockReason =
	NonNullable<CapabilityAvailability["reason"]>;

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

// ==[HUMAN APPROVED]== The full deep snapshot deliberately extends the shared conversationSummary
// contract (divergence (b), ADR-0032 pattern): it adds the heavy `messages`
// and `data` reads that the summary transport shape intentionally omits —
// the story reads messages through the paginated history seam, heavy
// provenance loads only through the Import Details operations, and a
// 92-byte Cast command must not re-serialize the entire Chat archive across
// the wire. Every shared header field (Cast, Control, validity, playability,
// capabilities, active generations) derives from the canonical schemas, so
// the two shapes cannot drift apart.
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
	// All server-owned targets at the active response position. The list is
	// empty when no generation is active and preserves every parallel sibling.
	activeGenerations: ActiveGenerationSnapshot[];
	messages: ConversationMessageSnapshot[];
	data: ConversationDataEntry[];
}

// The normal conversation header read model. It contains the state needed by
// navigation and mutation responses while deliberately excluding the complete
// message and conversation-data archives.
export type ConversationSummary = Omit<ConversationSnapshot, "messages" | "data">;

// One lightweight Variant in a paginated history read. The history read
// models derive from the canonical shared schemas (ADR-0032): the paginated
// seam and the wire contract share one declaration, so a read-model field
// added for rendering automatically participates in transport validation.
// Reasoning Content is part of the rendered response and therefore crosses
// this boundary when it exists; other provenance remains behind deliberate
// detail operations.
export type ChatHistoryVariant = SharedChatHistoryVariant;

// Stable Participant identity needed to render one Message: the immutable
// Author Stamp name plus the current active-Cast state. No prompts,
// openings, provenance, or editable Definition content is included.
export type ChatHistoryMessage = SharedChatHistoryMessage;

// The normal Chat read model for reading history: stable chronological
// pages of native Messages with the lightweight Participant identity needed
// for rendering. Persisted Reasoning Content is included with each Variant.
// Exact artifact bytes, the canonical archive text, signatures, and other
// heavy provenance load only through deliberate detail operations.
export type ChatHistoryPage = SharedChatHistoryPage;

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

// The command vocabulary derives from the canonical wire union (ADR-0032):
// a transport command added to the shared schema automatically becomes a
// domain action, so the two vocabularies cannot drift. The one deliberate
// extension (a): the domain add-participant action carries a server-only
// `sourceCharacterId` that the wire schema deliberately omits — clients can
// never forge or bypass provenance/revision rules at the transport
// boundary; only server-owned fork workflows supply it inside the
// transaction.
type WireConversationAction = SharedConversationAction;

export type ConversationAction =
	| Exclude<WireConversationAction, { type: "add-participant" }>
	| (Extract<WireConversationAction, { type: "add-participant" }> & {
			sourceCharacterId?: number | undefined;
	  });

export interface ConversationCommand {
	conversationId: number;
	expectedRevision: number;
	action: ConversationAction;
}

export interface ConversationModule {
	create(input: ConversationCreationInput): ConversationSnapshot;
	exists(conversationId: number): boolean;
	// Narrow authoritative revision read used when a preview send ignores the
	// client's stale revision; it does not load Conversation history.
	getRevision(conversationId: number): number | undefined;
	getSnapshot(conversationId: number): ConversationSnapshot | undefined;
	getSummary(conversationId: number): ConversationSummary | undefined;
	getGenerationSettings(
		conversationId: number,
	): ConversationGenerationSettings | undefined;
	// The Chat's selected recipe with each Referenced Prompt Block resolved
	// against this Chat's own Participant Definitions and selected history.
	// Undefined for a missing Conversation.
	getPromptPreset(conversationId: number): ConversationPromptPreset | undefined;
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
	readMacroVariables(
		conversationId: number,
		input?: { promptPresetId?: number; position?: number },
	): MacroVariables | undefined;
	editMacroVariables(input: import("./macro-variables").EditMacroVariablesInput): {
		conversation: ConversationSummary;
		variables: MacroVariables;
	};
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
	execute(command: ConversationCommand): ConversationSummary;
	// Server-owned Send lifecycle. Acceptance creates the ordinary human
	// Message and provisional model target in one revisioned transaction;
	// terminal transitions resolve or remove only that target.
	acceptTailGeneration(
		input: AcceptTailGenerationInput,
	): AcceptedTailGeneration;
	resolveGeneration(
		input: ResolveGenerationInput,
	): ConversationSummary;
	removeGeneration(
		input: RemoveGenerationInput,
	): ConversationSummary;
	stopGeneration(input: StopGenerationInput): ConversationSummary;
	stopGenerations(input: StopGenerationsInput): StoppedGenerations;
	acceptContinuationGeneration(
		input: AcceptContinuationGenerationInput,
	): AcceptedContinuationGeneration;
	checkpointGeneration(input: CheckpointGenerationInput): void;
	acceptSiblingGeneration(
		input: AcceptSiblingGenerationInput,
	): AcceptedSiblingGeneration;
}

export interface ActiveGenerationSnapshot {
	generationId: number;
	messageId: number;
	variantId: number;
	startedAt: string;
}

// Deliberate, on-demand read of one server-owned Active Generation. Derived
// from the canonical shared schema (ADR-0032): the inspection contract and
// the domain seam share one declaration, so an inspection field cannot
// drift between transport validation and the deep read. The captured plan
// and omitted history are intentionally absent from ordinary Conversation
// snapshots and history pages; they exist only while the active/replay
// lifecycle retains the generation row.
export type ActiveGenerationDetails = SharedActiveGenerationDetails;

// Compact terminal provenance is the only Generation detail that survives
// Active Generation cleanup. It has a positive allow-list by design: no
// request overrides, URLs, headers, credentials, or raw provider payloads.
export type GenerationProvenance = SharedGenerationProvenance;

// On-demand details for a terminal Variant. Derived from the canonical
// shared schema (ADR-0032) so the compact provenance contract cannot drift
// between transport validation and the deep read. Reasoning and arbitrary
// data rows remain outside this contract; Generation provenance is compact
// and safe while the normal history read stays lightweight.
export type VariantDetails = SharedVariantDetails;

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
	promptPlan: PromptPlan;
	// Active-only budget/omission diagnostics. Older direct callers may omit
	// this field; workflow callers always capture it before acceptance.
	promptInspection?: ConversationJsonValue | undefined;
	promptContext: ConversationJsonValue;
	generationSettings: ConversationJsonValue;
	connection: ConversationJsonValue;
	generationIntent?: ConversationJsonValue | undefined;
	provenance?: ConversationDataEntry | undefined;
	// Captured macro state belongs to this originating preset and is attached to the target only
	// when its Variant is retained. Direct domain callers may omit it for non-macro generations.
	macroPresetId?: number | undefined;
	macroWrites?: readonly MacroVariableWrite[] | undefined;
}

export interface AcceptedTailGeneration {
	generationId: number;
	humanMessageId: number;
	messageId: number;
	provisionalVariantId: number;
	conversation: ConversationSummary;
}

export interface ResolveGenerationInput {
	conversationId: number;
	generationId: number;
	timestamp: string;
	content: string;
	reasoning?: string | undefined;
	data?: readonly ConversationDataEntry[] | undefined;
}

// One canonical removal input. The Active Generation row's persisted intent
// decides the mutation; the caller never selects one.
export interface RemoveGenerationInput {
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

// Stop All is one Conversation-owned lifecycle transition. The target set is
// read inside the same transaction that resolves/removes every active target,
// so callers never observe a partially stopped response position.
export interface StopGenerationsInput {
	conversationId: number;
	timestamp?: string | undefined;
}

export interface StoppedGenerations {
	generationIds: number[];
	conversation: ConversationSummary;
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
	promptPlan: PromptPlan;
	promptInspection?: ConversationJsonValue | undefined;
	promptContext: ConversationJsonValue;
	generationSettings: ConversationJsonValue;
	connection: ConversationJsonValue;
	generationIntent?: ConversationJsonValue | undefined;
	provenance?: ConversationDataEntry | undefined;
	macroPresetId?: number | undefined;
	macroWrites?: readonly MacroVariableWrite[] | undefined;
}

export interface AcceptedContinuationGeneration {
	generationId: number;
	messageId: number;
	provisionalVariantId: number;
	conversation: ConversationSummary;
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
	promptPlan: PromptPlan;
	promptInspection?: ConversationJsonValue | undefined;
	promptContext: ConversationJsonValue;
	generationSettings: ConversationJsonValue;
	connection: ConversationJsonValue;
	generationIntent?: ConversationJsonValue | undefined;
	provenance?: ConversationDataEntry | undefined;
	macroPresetId?: number | undefined;
	macroWrites?: readonly MacroVariableWrite[] | undefined;
}

export interface AcceptedSiblingGeneration {
	generationId: number;
	messageId: number;
	provisionalVariantId: number;
	priorVariantId: number | null;
	conversation: ConversationSummary;
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
	// Native creation captures the initiating client's formatting context for
	// the one opening assembly; imported/preservation records leave these unset.
	macroTimeZone?: string | undefined;
	macroLocale?: string | undefined;
}
