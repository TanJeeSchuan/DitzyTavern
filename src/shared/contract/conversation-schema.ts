import { Kind, Type, type Static } from "@sinclair/typebox";
import { characterConflict, characterSnapshot } from "./character-library";
import { participantPrompt } from "./prompt-schema";
import {
	invalidOutcome,
	notFoundOutcome,
	notPlayableOutcome,
	notRemovableOutcome,
	conflictReasonOutcome,
} from "./outcomes";
import { numericWire } from "./wire";
import type {
	GenerationJsonObject,
	GenerationJsonValue,
	GenerationProvenance as SharedGenerationProvenance,
} from "../generation-provenance";

// Preserve the established contract export while keeping the schema owned by
// the shared prompt module used by both Conversation and Character contracts.
export { participantPrompt };

const castParticipant = Type.Object({
	id: Type.Integer(),
	position: Type.Integer(),
	name: Type.String(),
	prompt: participantPrompt,
	openings: Type.Array(Type.String()),
	sourceCharacterId: Type.Union([Type.Null(), Type.Integer()]),
	sourceCharacterName: Type.Union([Type.Null(), Type.String()]),
	// Derived fields so clients never reproduce Cast rules.
	duplicateLabel: Type.String(),
	removal: Type.Object({
		eligible: Type.Boolean(),
		reason: Type.Union([Type.Literal("control-assigned"), Type.Null()]),
		// Derived removal impact presented by the confirmation flow: the
		// deletion mode names hard delete versus tombstone, and the
		// affected-generation count states how many Messages lose future
		// sibling Variant generation.
		deletionMode: Type.Union([
			Type.Literal("hard-delete"),
			Type.Literal("tombstone"),
			Type.Null(),
		]),
		affectedGenerationCount: Type.Integer(),
	}),
});

const conversationControl = Type.Object({
	humanParticipantId: Type.Union([Type.Null(), Type.Integer()]),
	modelParticipantId: Type.Union([Type.Null(), Type.Integer()]),
});

const conversationControlValidity = Type.Object({
	valid: Type.Boolean(),
	reason: Type.Union([
		Type.Literal("missing-seat"),
		Type.Literal("seats-not-distinct"),
		Type.Literal("seat-not-in-cast"),
		Type.Null(),
	]),
});

const capabilityAvailability = Type.Object({
	available: Type.Boolean(),
	reason: Type.Union([
		Type.Literal("conversation-not-playable"),
		Type.Null(),
	]),
});

const conversationCapabilities = Type.Object({
	compose: capabilityAvailability,
	generate: capabilityAvailability,
	swipe: capabilityAvailability,
});

// Provider request overrides and retained generation details are restricted
// to the shared generation JSON vocabulary. The runtime schema stays open
// like the previous opaque payload boundary, while the Unsafe generic keeps
// Eden's Static type exact and recursive instead of widening these fields to
// `unknown`.
const jsonValue = Type.Unsafe<GenerationJsonValue>({ [Kind]: "Unknown" });
const jsonObject = Type.Record(Type.String(), jsonValue);

export type GenerationDetailsJsonValue = GenerationJsonValue;
export type GenerationDetailsJsonObject = GenerationJsonObject;
export type GenerationRequestValue = GenerationDetailsJsonValue;
export type GenerationRequestOverrides = GenerationJsonObject;

const activeGenerations = Type.Array(Type.Object({
	generationId: Type.Integer(),
	messageId: Type.Integer(),
	variantId: Type.Integer(),
	startedAt: Type.String(),
}));

// The conversational transport shape for every response that returns a
// Conversation: the header, the full Cast, Control, and the derived
// playability and capability state. Messages and per-Conversation data are
// deliberately never shipped here: the story reads through the paginated
// history seam, heavy provenance loads only through the Import Details
// operations, and a 92-byte Cast command must not re-serialize the entire
// Chat archive across the wire.
export const conversationSummary = Type.Object({
	id: Type.Integer(),
	name: Type.String(),
	revision: Type.Integer(),
	cast: Type.Array(castParticipant),
	control: conversationControl,
	controlValidity: conversationControlValidity,
	playable: Type.Boolean(),
	capabilities: conversationCapabilities,
	activeGenerations,
});

export type ParticipantPrompt = Static<typeof participantPrompt>;
export type CastParticipant = Static<typeof castParticipant>;
export type ConversationControl = Static<typeof conversationControl>;
export type ConversationControlValidity = Static<typeof conversationControlValidity>;
export type ConversationSummary = Static<typeof conversationSummary>;

export const conversationGenerationSettings = Type.Object({
	modelId: Type.String(),
	temperature: Type.Union([Type.Null(), Type.Number()]),
	topP: Type.Union([Type.Null(), Type.Number()]),
	frequencyPenalty: Type.Union([Type.Null(), Type.Number()]),
	presencePenalty: Type.Union([Type.Null(), Type.Number()]),
	contextLimit: Type.Integer(),
	responseBudget: Type.Integer(),
	safetyAllowance: Type.Integer(),
	siblingGenerationLimit: Type.Integer(),
	continuationStrategy: Type.Union([
		Type.Literal("instruction"),
		Type.Literal("assistant-prefill"),
	]),
	continuationInstruction: Type.String(),
	continuationPrefillSuffix: Type.Union([
		Type.Literal(""),
		Type.Literal(" "),
		Type.Literal("\n"),
		Type.Literal("\n\n"),
	]),
	requestOverrides: Type.Object({
		"chat-completions": jsonObject,
		responses: jsonObject,
		"anthropic-messages": jsonObject,
	}),
});

export type ConversationGenerationSettings = Static<typeof conversationGenerationSettings>;
export type ContinuationPrefillSuffix = ConversationGenerationSettings["continuationPrefillSuffix"];

export const generationVariant = Type.Object({
	messageId: Type.Integer(),
	variantId: Type.Integer(),
	content: Type.String(),
	timestamp: Type.String(),
	data: Type.Array(Type.Object({
		namespace: Type.String(),
		key: Type.String(),
		value: Type.String(),
	})),
});

export type GenerationVariant = Static<typeof generationVariant>;

const generationProvenance = Type.Union([Type.Null(), Type.Object({
	connectionProfileId: Type.Union([Type.Null(), Type.Integer()]),
	connectionSettingsRevision: Type.Union([Type.Null(), Type.Integer()]),
	modelBackend: Type.Union([Type.Null(), Type.String()]),
	adapter: Type.Union([Type.Null(), Type.String()]),
	modelId: Type.Union([Type.Null(), Type.String()]),
	generationSettings: Type.Object({
		temperature: Type.Union([Type.Null(), Type.Number()]),
		topP: Type.Union([Type.Null(), Type.Number()]),
		frequencyPenalty: Type.Union([Type.Null(), Type.Number()]),
		presencePenalty: Type.Union([Type.Null(), Type.Number()]),
		contextLimit: Type.Union([Type.Null(), Type.Integer()]),
		responseBudget: Type.Union([Type.Null(), Type.Integer()]),
		safetyAllowance: Type.Union([Type.Null(), Type.Integer()]),
		siblingGenerationLimit: Type.Union([Type.Null(), Type.Integer()]),
		continuationStrategy: Type.Union([Type.Literal("instruction"), Type.Literal("assistant-prefill"), Type.Null()]),
		continuationInstruction: Type.Union([Type.Null(), Type.String()]),
		continuationPrefillSuffix: Type.Union([Type.Literal(""), Type.Literal(" "), Type.Literal("\n"), Type.Literal("\n\n"), Type.Null()]),
	}),
	usage: Type.Union([Type.Null(), Type.Record(Type.String(), Type.Number())]),
	finishReason: Type.Union([Type.Literal("stop"), Type.Literal("length"), Type.Literal("other"), Type.Null()]),
	status: Type.Union([Type.Literal("complete"), Type.Literal("length-limited"), Type.Literal("interrupted")]),
	interruptionCause: Type.Union([Type.Null(), Type.String()]),
})]);

// Active details are intentionally a separate contract from Conversation
// summaries and ordinary history. Opaque prompt JSON is provider-neutral and
// retained only for the bounded Active Generation/replay lifecycle.
export const activeGenerationDetails = Type.Object({
	conversationId: Type.Integer(),
	generationId: Type.Integer(),
	messageId: Type.Integer(),
	variantId: Type.Integer(),
	startedAt: Type.String(),
	status: Type.Union([
		Type.Literal("active"),
		Type.Literal("complete"),
		Type.Literal("length-limited"),
		Type.Literal("interrupted"),
	]),
	intent: jsonValue,
	participants: Type.Object({
		human: Type.Object({ id: Type.Integer(), name: Type.String() }),
		model: Type.Object({ id: Type.Integer(), name: Type.String() }),
	}),
	promptPlan: jsonValue,
	historyRoles: jsonValue,
	generationSettings: jsonValue,
	connection: jsonValue,
	budget: Type.Object({
		tokenEstimate: Type.Union([Type.Null(), Type.Integer()]),
		responseBudget: Type.Union([Type.Null(), Type.Integer()]),
		safetyAllowance: Type.Union([Type.Null(), Type.Integer()]),
		contextLimit: Type.Union([Type.Null(), Type.Integer()]),
		totalRequiredTokens: Type.Union([Type.Null(), Type.Integer()]),
		omittedHistory: jsonValue,
	}),
	checkpoint: Type.Object({
		content: Type.String(),
		reasoning: Type.String(),
		latestEventId: Type.Integer(),
		checkpointedAt: Type.Union([Type.Null(), Type.String()]),
	}),
});

export type GenerationInspectionStatus = Static<typeof activeGenerationDetails>["status"];
export type ActiveGenerationDetails = Static<typeof activeGenerationDetails>;

export const variantDetails = Type.Object({
	conversationId: Type.Integer(),
	messageId: Type.Integer(),
	variantId: Type.Integer(),
	content: Type.String(),
	timestamp: Type.String(),
	author: Type.Union([Type.Null(), Type.Object({
		participantId: Type.Union([Type.Null(), Type.Integer()]),
		capturedName: Type.Union([Type.Null(), Type.String()]),
		inCast: Type.Boolean(),
	})]),
	historicalContext: Type.Union([Type.Null(), Type.Object({
		humanParticipantId: Type.Integer(),
		modelParticipantId: Type.Integer(),
	})]),
	provenance: generationProvenance,
});

export type GenerationProvenance = SharedGenerationProvenance;
export type VariantDetails = Static<typeof variantDetails>;

// Lightweight paginated history read contract: stable chronological pages
// of native Messages with the Participant identity and selected Variant
// state needed for rendering. Heavy provenance never crosses this contract.
const chatHistoryVariant = Type.Object({
	id: Type.Integer(),
	position: Type.Integer(),
	content: Type.String(),
	timestamp: Type.String(),
	selected: Type.Boolean(),
});

export type ChatHistoryVariant = Static<typeof chatHistoryVariant>;

const chatHistoryMessage = Type.Object({
	id: Type.Integer(),
	position: Type.Integer(),
	timestamp: Type.String(),
	// Historical model Control identity used to decide whether a terminal
	// Message is eligible for Continue after Control changes.
	modelParticipantIdAtCreation: Type.Optional(Type.Union([Type.Null(), Type.Integer()])),
	// Server-derived capability for the selected Variant. Reasoning remains
	// private even when it makes a reasoning-only Message continuable.
	continuable: Type.Optional(Type.Boolean()),
	author: Type.Union([Type.Null(), Type.Object({
		participantId: Type.Union([Type.Null(), Type.Integer()]),
		capturedName: Type.Union([Type.Null(), Type.String()]),
		inCast: Type.Boolean(),
	})]),
	variants: Type.Array(chatHistoryVariant),
});

export type ChatHistoryMessage = Static<typeof chatHistoryMessage>;

export const chatHistoryPage = Type.Object({
	conversationId: Type.Integer(),
	name: Type.String(),
	revision: Type.Integer(),
	cast: Type.Array(
		Type.Object({
			id: Type.Integer(),
			position: Type.Integer(),
			name: Type.String(),
		}),
	),
	page: Type.Object({
		index: Type.Integer(),
		pageSize: Type.Integer(),
		totalMessages: Type.Integer(),
		totalPages: Type.Integer(),
		hasOlder: Type.Boolean(),
		hasNewer: Type.Boolean(),
	}),
	messages: Type.Array(chatHistoryMessage),
});

export type ChatHistoryPage = Static<typeof chatHistoryPage>;

// The author stamp is inline in the message schema; derive it so the
// paginated history client can type Participant stamps without a duplicate
// declaration.
export type ChatHistoryAuthorStamp = NonNullable<ChatHistoryMessage["author"]>;

const participantDefinition = Type.Object({
	name: Type.String(),
	prompt: participantPrompt,
	openings: Type.Array(Type.String()),
});

export type ParticipantDefinition = Static<typeof participantDefinition>;

const dataScope = Type.Union([
	Type.Object({ type: Type.Literal("conversation") }),
	Type.Object({ type: Type.Literal("message"), messageId: Type.Integer() }),
	Type.Object({
		type: Type.Literal("variant"),
		messageId: Type.Integer(),
		variantId: Type.Integer(),
	}),
]);

const createMessageAction = Type.Object({
	type: Type.Literal("create-message"),
	timestamp: Type.String(),
	variantContents: Type.Array(Type.String()),
	selectedVariantIndex: Type.Optional(Type.Integer()),
	authorParticipantId: Type.Integer(),
});

const createVariantAction = Type.Object({
	type: Type.Literal("create-variant"),
	messageId: Type.Integer(),
	content: Type.String(),
});

const selectVariantAction = Type.Object({
	type: Type.Literal("select-variant"),
	messageId: Type.Integer(),
	variantId: Type.Integer(),
});

const editVariantAction = Type.Object({
	type: Type.Literal("edit-variant"),
	messageId: Type.Integer(),
	variantId: Type.Integer(),
	content: Type.String(),
});

const deleteVariantAction = Type.Object({
	type: Type.Literal("delete-variant"),
	messageId: Type.Integer(),
	variantId: Type.Integer(),
});

const deleteMessageAction = Type.Object({
	type: Type.Literal("delete-message"),
	messageId: Type.Integer(),
});

const putDataAction = Type.Object({
	type: Type.Literal("put-data"),
	scope: dataScope,
	namespace: Type.String(),
	key: Type.String(),
	value: Type.String(),
});

const deleteDataAction = Type.Object({
	type: Type.Literal("delete-data"),
	scope: dataScope,
	namespace: Type.String(),
	key: Type.String(),
});

const generationSettings = Type.Object({
	modelId: Type.String(),
	temperature: Type.Union([Type.Null(), Type.Number()]),
	topP: Type.Union([Type.Null(), Type.Number()]),
	frequencyPenalty: Type.Union([Type.Null(), Type.Number()]),
	presencePenalty: Type.Union([Type.Null(), Type.Number()]),
	contextLimit: Type.Integer(),
	responseBudget: Type.Integer(),
	safetyAllowance: Type.Optional(Type.Integer()),
	continuationStrategy: Type.Optional(Type.Union([
		Type.Literal("instruction"),
		Type.Literal("assistant-prefill"),
	])),
	continuationInstruction: Type.Optional(Type.String()),
	continuationPrefillSuffix: Type.Optional(Type.Union([
		Type.Literal(""),
		Type.Literal(" "),
		Type.Literal("\n"),
		Type.Literal("\n\n"),
	])),
	requestOverrides: Type.Object({
		"chat-completions": Type.Record(Type.String(), Type.Unknown()),
		responses: Type.Record(Type.String(), Type.Unknown()),
		"anthropic-messages": Type.Record(Type.String(), Type.Unknown()),
	}),
});

const updateGenerationSettingsAction = Type.Object({
	type: Type.Literal("update-generation-settings"),
	settings: generationSettings,
});

// Cast management command. The raw command appends an ad-hoc or already-
// resolved local Definition only; Character-to-Cast forks flow through the
// explicit workflow route, which checks both revisions and copies the
// authoritative Definition server-side. `sourceCharacterId` is deliberately
// absent here so a client can never forge or bypass provenance/revision
// rules at the transport boundary.
const addParticipantAction = Type.Object({
	type: Type.Literal("add-participant"),
	definition: participantDefinition,
});

const renameParticipantAction = Type.Object({
	type: Type.Literal("rename-participant"),
	participantId: Type.Integer(),
	name: Type.String(),
});

const replaceParticipantPromptAction = Type.Object({
	type: Type.Literal("replace-participant-prompt"),
	participantId: Type.Integer(),
	prompt: participantPrompt,
});

const replaceParticipantOpeningsAction = Type.Object({
	type: Type.Literal("replace-participant-openings"),
	participantId: Type.Integer(),
	openings: Type.Array(Type.String()),
});

const assignControlAction = Type.Object({
	type: Type.Literal("assign-control"),
	seat: Type.Union([Type.Literal("human"), Type.Literal("model")]),
	participantId: Type.Integer(),
});

// Removes an unseated Participant after confirmation. Seated Participants
// are protected with the typed not-removable outcome; the derived
// deletion-mode and affected-generation count come from the snapshot, never
// reconstructed by the client.
const removeParticipantAction = Type.Object({
	type: Type.Literal("remove-participant"),
	participantId: Type.Integer(),
});

const conversationCommandAction = Type.Union([
	createMessageAction,
	createVariantAction,
	selectVariantAction,
	editVariantAction,
	deleteVariantAction,
	deleteMessageAction,
	putDataAction,
	deleteDataAction,
	updateGenerationSettingsAction,
	addParticipantAction,
	renameParticipantAction,
	replaceParticipantPromptAction,
	replaceParticipantOpeningsAction,
	assignControlAction,
	removeParticipantAction,
]);

export type ConversationAction = Static<typeof conversationCommandAction>;

// The revision is part of the Conversation command; the conversation id
// lives in the route path.
export const conversationCommandBody = Type.Object({
	expectedRevision: Type.Integer(),
	action: conversationCommandAction,
});

// Send carries the client draft and the Conversation revision it was based
// on. Generation acceptance is deliberately a complete typed operation: an
// omitted revision or draft must never fall through to an older request shape.
export const generationBody = Type.Object({
	expectedRevision: Type.Integer(),
	content: Type.String(),
});

// Continue carries only the Conversation revision. The server derives the
// selected terminal Message and current Control pair from its snapshot.
export const continuationBody = Type.Object({
	expectedRevision: Type.Integer(),
});

export type ConversationCommandBody = Static<typeof conversationCommandBody>;
export type GenerationBody = Static<typeof generationBody>;
export type ContinuationBody = Static<typeof continuationBody>;

export const conversationConflict = Type.Object({
	outcome: Type.Literal("conflict"),
	expectedRevision: Type.Integer(),
	actualRevision: Type.Integer(),
	currentConversation: conversationSummary,
});

export const generationAccepted = Type.Object({
	outcome: Type.Literal("accepted"),
	generationId: Type.Integer(),
	conversationId: Type.Integer(),
	messageId: Type.Integer(),
	variantId: Type.Integer(),
});

export const generationStartResponse = Type.Union([
	generationAccepted,
	notFoundOutcome,
	conflictReasonOutcome,
	notPlayableOutcome,
	invalidOutcome,
]);

export type GenerationAccepted = Static<typeof generationAccepted>;
export type GenerationStartResponse = Static<typeof generationStartResponse>;

export const generationStopped = Type.Object({
	outcome: Type.Literal("stopped"),
	generationId: Type.Integer(),
	conversation: conversationSummary,
});

export const generationsStopped = Type.Object({
	outcome: Type.Literal("stopped"),
	generationIds: Type.Array(Type.Integer()),
	conversation: conversationSummary,
});

export type GenerationStopped = Static<typeof generationStopped>;
export type GenerationsStopped = Static<typeof generationsStopped>;

// Route boundary schemas referenced by the Conversation adapter: path and
// query params arrive as wire strings, and the response maps reuse these
// named contracts instead of re-declaring shapes at the boundary.

export const conversationIdParams = Type.Object({ id: numericWire });

export const generationIdParams = Type.Object({
	id: numericWire,
	generationId: numericWire,
});

export const messageIdParams = Type.Object({
	id: numericWire,
	messageId: numericWire,
});

export const variantIdParams = Type.Object({
	id: numericWire,
	messageId: numericWire,
	variantId: numericWire,
});

export const participantIdParams = Type.Object({
	id: numericWire,
	participantId: numericWire,
});

export const historyPageQuery = Type.Object({
	page: Type.Optional(numericWire),
	pageSize: Type.Optional(numericWire),
});

export const generationEventsQuery = Type.Object({
	after: Type.Optional(numericWire),
});

export const conversationAppliedResponse = Type.Object({
	outcome: Type.Literal("applied"),
	conversation: conversationSummary,
});

export const characterAppliedResponse = Type.Object({
	outcome: Type.Literal("applied"),
	character: characterSnapshot,
});

export const generationConflictResponse = Type.Union([
	conflictReasonOutcome,
	notPlayableOutcome,
]);

export const conversationCommandConflict = Type.Union([
	conversationConflict,
	notPlayableOutcome,
	notRemovableOutcome,
]);

export const castCharacterConflict = Type.Union([
	characterConflict,
	conversationConflict,
]);

export const addCharacterToCastBody = Type.Object({
	expectedConversationRevision: Type.Integer(),
	characterId: Type.Integer(),
	expectedCharacterRevision: Type.Integer(),
});

export const saveParticipantAsCharacterBody = Type.Object({
	expectedConversationRevision: Type.Integer(),
});
