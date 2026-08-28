import type { Database } from "bun:sqlite";
import { t, type Static } from "elysia";
import { Kind, Type } from "@sinclair/typebox";
import {
	type ConversationSnapshot,
	createConversationModule,
	type StaleConversationRevisionError,
} from "../../server/conversation";
import { withDatabase } from "../../server/database/database";
import { characterSnapshot } from "./character-library";
import type {
	GenerationJsonObject,
	GenerationJsonValue,
	GenerationProvenance as SharedGenerationProvenance,
} from "../generation-provenance";

export const participantPrompt = t.Object({
	systemInstruction: t.String(),
	identity: t.String(),
	scenario: t.String(),
	exampleDialogue: t.String(),
	postHistoryInstruction: t.String(),
});

const castParticipant = t.Object({
	id: t.Integer(),
	position: t.Integer(),
	name: t.String(),
	prompt: participantPrompt,
	openings: t.Array(t.String()),
	sourceCharacterId: t.Nullable(t.Integer()),
	sourceCharacterName: t.Nullable(t.String()),
	// Derived fields so clients never reproduce Cast rules.
	duplicateLabel: t.String(),
	removal: t.Object({
		eligible: t.Boolean(),
		reason: t.Union([t.Literal("control-assigned"), t.Null()]),
		// Derived removal impact presented by the confirmation flow: the
		// deletion mode names hard delete versus tombstone, and the
		// affected-generation count states how many Messages lose future
		// sibling Variant generation.
		deletionMode: t.Union([
			t.Literal("hard-delete"),
			t.Literal("tombstone"),
			t.Null(),
		]),
		affectedGenerationCount: t.Integer(),
	}),
});

const conversationControl = t.Object({
	humanParticipantId: t.Nullable(t.Integer()),
	modelParticipantId: t.Nullable(t.Integer()),
});

const conversationControlValidity = t.Object({
	valid: t.Boolean(),
	reason: t.Union([
		t.Literal("missing-seat"),
		t.Literal("seats-not-distinct"),
		t.Literal("seat-not-in-cast"),
		t.Null(),
	]),
});

const capabilityAvailability = t.Object({
	available: t.Boolean(),
	reason: t.Union([
		t.Literal("conversation-not-playable"),
		t.Null(),
	]),
});

const conversationCapabilities = t.Object({
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

const activeGenerations = t.Array(t.Object({
	generationId: t.Integer(),
	messageId: t.Integer(),
	variantId: t.Integer(),
	startedAt: t.String(),
}));

// The conversational transport shape for every response that returns a
// Conversation: the header, the full Cast, Control, and the derived
// playability and capability state. Messages and per-Conversation data are
// deliberately never shipped here: the story reads through the paginated
// history seam, heavy provenance loads only through the Import Details
// operations, and a 92-byte Cast command must not re-serialize the entire
// Chat archive across the wire.
export const conversationSummary = t.Object({
	id: t.Integer(),
	name: t.String(),
	revision: t.Integer(),
	cast: t.Array(castParticipant),
	control: conversationControl,
	controlValidity: conversationControlValidity,
	playable: t.Boolean(),
	capabilities: conversationCapabilities,
	activeGenerations,
});

export type ParticipantPrompt = Static<typeof participantPrompt>;
export type CastParticipant = Static<typeof castParticipant>;
export type ConversationControl = Static<typeof conversationControl>;
export type ConversationControlValidity = Static<typeof conversationControlValidity>;
export type ConversationSummary = Static<typeof conversationSummary>;

export const conversationGenerationSettings = t.Object({
	modelId: t.String(),
	temperature: t.Nullable(t.Number()),
	topP: t.Nullable(t.Number()),
	frequencyPenalty: t.Nullable(t.Number()),
	presencePenalty: t.Nullable(t.Number()),
	contextLimit: t.Integer(),
	responseBudget: t.Integer(),
	safetyAllowance: t.Integer(),
	siblingGenerationLimit: t.Integer(),
	continuationStrategy: t.Union([
		t.Literal("instruction"),
		t.Literal("assistant-prefill"),
	]),
	continuationInstruction: t.String(),
	continuationPrefillSuffix: t.Union([
		t.Literal(""),
		t.Literal(" "),
		t.Literal("\n"),
		t.Literal("\n\n"),
	]),
	requestOverrides: t.Object({
		"chat-completions": jsonObject,
		responses: jsonObject,
		"anthropic-messages": jsonObject,
	}),
});

export type ConversationGenerationSettings = Static<typeof conversationGenerationSettings>;
export type ContinuationPrefillSuffix = ConversationGenerationSettings["continuationPrefillSuffix"];

export const generationVariant = t.Object({
	messageId: t.Integer(),
	variantId: t.Integer(),
	content: t.String(),
	timestamp: t.String(),
	data: t.Array(t.Object({
		namespace: t.String(),
		key: t.String(),
		value: t.String(),
	})),
});

export type GenerationVariant = Static<typeof generationVariant>;

const generationProvenance = t.Nullable(t.Object({
	connectionProfileId: t.Nullable(t.Integer()),
	connectionSettingsRevision: t.Nullable(t.Integer()),
	modelBackend: t.Nullable(t.String()),
	adapter: t.Nullable(t.String()),
	modelId: t.Nullable(t.String()),
	generationSettings: t.Object({
		temperature: t.Nullable(t.Number()),
		topP: t.Nullable(t.Number()),
		frequencyPenalty: t.Nullable(t.Number()),
		presencePenalty: t.Nullable(t.Number()),
		contextLimit: t.Nullable(t.Integer()),
		responseBudget: t.Nullable(t.Integer()),
		safetyAllowance: t.Nullable(t.Integer()),
		siblingGenerationLimit: t.Nullable(t.Integer()),
		continuationStrategy: t.Union([t.Literal("instruction"), t.Literal("assistant-prefill"), t.Null()]),
		continuationInstruction: t.Nullable(t.String()),
		continuationPrefillSuffix: t.Union([t.Literal(""), t.Literal(" "), t.Literal("\n"), t.Literal("\n\n"), t.Null()]),
	}),
	usage: t.Nullable(t.Record(t.String(), t.Number())),
	finishReason: t.Union([t.Literal("stop"), t.Literal("length"), t.Literal("other"), t.Null()]),
	status: t.Union([t.Literal("complete"), t.Literal("length-limited"), t.Literal("interrupted")]),
	interruptionCause: t.Nullable(t.String()),
}));

// Active details are intentionally a separate contract from Conversation
// summaries and ordinary history. Opaque prompt JSON is provider-neutral and
// retained only for the bounded Active Generation/replay lifecycle.
export const activeGenerationDetails = t.Object({
	conversationId: t.Integer(),
	generationId: t.Integer(),
	messageId: t.Integer(),
	variantId: t.Integer(),
	startedAt: t.String(),
	status: t.Union([
		t.Literal("active"),
		t.Literal("complete"),
		t.Literal("length-limited"),
		t.Literal("interrupted"),
	]),
	intent: jsonValue,
	participants: t.Object({
		human: t.Object({ id: t.Integer(), name: t.String() }),
		model: t.Object({ id: t.Integer(), name: t.String() }),
	}),
	promptPlan: jsonValue,
	historyRoles: jsonValue,
	generationSettings: jsonValue,
	connection: jsonValue,
	budget: t.Object({
		tokenEstimate: t.Nullable(t.Integer()),
		responseBudget: t.Nullable(t.Integer()),
		safetyAllowance: t.Nullable(t.Integer()),
		contextLimit: t.Nullable(t.Integer()),
		totalRequiredTokens: t.Nullable(t.Integer()),
		omittedHistory: jsonValue,
	}),
	checkpoint: t.Object({
		content: t.String(),
		reasoning: t.String(),
		latestEventId: t.Integer(),
		checkpointedAt: t.Nullable(t.String()),
	}),
});

export type GenerationInspectionStatus = Static<typeof activeGenerationDetails>["status"];
export type ActiveGenerationDetails = Static<typeof activeGenerationDetails>;

export const variantDetails = t.Object({
	conversationId: t.Integer(),
	messageId: t.Integer(),
	variantId: t.Integer(),
	content: t.String(),
	timestamp: t.String(),
	author: t.Nullable(t.Object({
		participantId: t.Nullable(t.Integer()),
		capturedName: t.Nullable(t.String()),
		inCast: t.Boolean(),
	})),
	historicalContext: t.Nullable(t.Object({
		humanParticipantId: t.Integer(),
		modelParticipantId: t.Integer(),
	})),
	provenance: generationProvenance,
});

export type GenerationProvenance = SharedGenerationProvenance;
export type VariantDetails = Static<typeof variantDetails>;

// Adapts the seam's immutable snapshot into the summary transport shape: the
// Conversation seam returns readonly arrays, while the typed response
// contract declares mutable ones. Mirrors toCharacterPayload in the
// Character Library contract.
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

// Lightweight paginated history read contract: stable chronological pages
// of native Messages with the Participant identity and selected Variant
// state needed for rendering. Heavy provenance never crosses this contract.
const chatHistoryVariant = t.Object({
	id: t.Integer(),
	position: t.Integer(),
	content: t.String(),
	timestamp: t.String(),
	selected: t.Boolean(),
});

const chatHistoryMessage = t.Object({
	id: t.Integer(),
	position: t.Integer(),
	timestamp: t.String(),
	modelParticipantIdAtCreation: t.Optional(t.Nullable(t.Integer())),
	continuable: t.Optional(t.Boolean()),
	author: t.Nullable(
		t.Object({
			participantId: t.Nullable(t.Integer()),
			capturedName: t.Nullable(t.String()),
			inCast: t.Boolean(),
		}),
	),
	variants: t.Array(chatHistoryVariant),
});

export const chatHistoryPage = t.Object({
	conversationId: t.Integer(),
	name: t.String(),
	revision: t.Integer(),
	cast: t.Array(
		t.Object({
			id: t.Integer(),
			position: t.Integer(),
			name: t.String(),
		}),
	),
	page: t.Object({
		index: t.Integer(),
		pageSize: t.Integer(),
		totalMessages: t.Integer(),
		totalPages: t.Integer(),
		hasOlder: t.Boolean(),
		hasNewer: t.Boolean(),
	}),
	messages: t.Array(chatHistoryMessage),
});

// Builds the typed stale-revision recovery shared by every Conversation
// route: the authoritative summary is re-read and returned inside the 409
// conflict payload, or a 404 when the Conversation disappeared in the
// meantime. One helper keeps error mapping from drifting between the
// command, fork, and save-as-Character workflow routes.
export const staleConversationConflict = (
	database: Database | undefined,
	conversationId: number,
	error: StaleConversationRevisionError,
):
	| { outcome: "not-found" }
	| {
			outcome: "conflict";
			expectedRevision: number;
			actualRevision: number;
			currentConversation: ReturnType<typeof toConversationSummary>;
	  } => {
	const current = withDatabase(database, (connection) =>
		createConversationModule(connection).getSnapshot(conversationId),
	);
	if (current === undefined) {
		// The Conversation disappeared between the conflict and the recovery
		// read; never fabricate authoritative state.
		return { outcome: "not-found" as const };
	}
	return {
		outcome: "conflict" as const,
		expectedRevision: error.expectedRevision,
		actualRevision: error.actualRevision,
		currentConversation: toConversationSummary(current),
	};
};

const participantDefinition = t.Object({
	name: t.String(),
	prompt: participantPrompt,
	openings: t.Array(t.String()),
});

export type ParticipantDefinition = Static<typeof participantDefinition>;

const dataScope = t.Union([
	t.Object({ type: t.Literal("conversation") }),
	t.Object({ type: t.Literal("message"), messageId: t.Integer() }),
	t.Object({
		type: t.Literal("variant"),
		messageId: t.Integer(),
		variantId: t.Integer(),
	}),
]);

const createMessageAction = t.Object({
	type: t.Literal("create-message"),
	timestamp: t.String(),
	variantContents: t.Array(t.String()),
	selectedVariantIndex: t.Optional(t.Integer()),
	authorParticipantId: t.Integer(),
});

const createVariantAction = t.Object({
	type: t.Literal("create-variant"),
	messageId: t.Integer(),
	content: t.String(),
});

const selectVariantAction = t.Object({
	type: t.Literal("select-variant"),
	messageId: t.Integer(),
	variantId: t.Integer(),
});

const editVariantAction = t.Object({
	type: t.Literal("edit-variant"),
	messageId: t.Integer(),
	variantId: t.Integer(),
	content: t.String(),
});

const deleteVariantAction = t.Object({
	type: t.Literal("delete-variant"),
	messageId: t.Integer(),
	variantId: t.Integer(),
});

const deleteMessageAction = t.Object({
	type: t.Literal("delete-message"),
	messageId: t.Integer(),
});

const putDataAction = t.Object({
	type: t.Literal("put-data"),
	scope: dataScope,
	namespace: t.String(),
	key: t.String(),
	value: t.String(),
});

const deleteDataAction = t.Object({
	type: t.Literal("delete-data"),
	scope: dataScope,
	namespace: t.String(),
	key: t.String(),
});

const generationSettings = t.Object({
	modelId: t.String(),
	temperature: t.Nullable(t.Number()),
	topP: t.Nullable(t.Number()),
	frequencyPenalty: t.Nullable(t.Number()),
	presencePenalty: t.Nullable(t.Number()),
	contextLimit: t.Integer(),
	responseBudget: t.Integer(),
	safetyAllowance: t.Optional(t.Integer()),
	continuationStrategy: t.Optional(t.Union([
		t.Literal("instruction"),
		t.Literal("assistant-prefill"),
	])),
	continuationInstruction: t.Optional(t.String()),
	continuationPrefillSuffix: t.Optional(t.Union([
		t.Literal(""),
		t.Literal(" "),
		t.Literal("\n"),
		t.Literal("\n\n"),
	])),
	requestOverrides: t.Object({
		"chat-completions": t.Record(t.String(), t.Unknown()),
		responses: t.Record(t.String(), t.Unknown()),
		"anthropic-messages": t.Record(t.String(), t.Unknown()),
	}),
});

const updateGenerationSettingsAction = t.Object({
	type: t.Literal("update-generation-settings"),
	settings: generationSettings,
});

// Cast management command. The raw command appends an ad-hoc or already-
// resolved local Definition only; Character-to-Cast forks flow through the
// explicit workflow route, which checks both revisions and copies the
// authoritative Definition server-side. `sourceCharacterId` is deliberately
// absent here so a client can never forge or bypass provenance/revision
// rules at the transport boundary.
const addParticipantAction = t.Object({
	type: t.Literal("add-participant"),
	definition: participantDefinition,
});

const renameParticipantAction = t.Object({
	type: t.Literal("rename-participant"),
	participantId: t.Integer(),
	name: t.String(),
});

const replaceParticipantPromptAction = t.Object({
	type: t.Literal("replace-participant-prompt"),
	participantId: t.Integer(),
	prompt: participantPrompt,
});

const replaceParticipantOpeningsAction = t.Object({
	type: t.Literal("replace-participant-openings"),
	participantId: t.Integer(),
	openings: t.Array(t.String()),
});

const assignControlAction = t.Object({
	type: t.Literal("assign-control"),
	seat: t.Union([t.Literal("human"), t.Literal("model")]),
	participantId: t.Integer(),
});

// Removes an unseated Participant after confirmation. Seated Participants
// are protected with the typed not-removable outcome; the derived
// deletion-mode and affected-generation count come from the snapshot, never
// reconstructed by the client.
const removeParticipantAction = t.Object({
	type: t.Literal("remove-participant"),
	participantId: t.Integer(),
});

const conversationCommandAction = t.Union([
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
export const conversationCommandBody = t.Object({
	expectedRevision: t.Integer(),
	action: conversationCommandAction,
});

// Send carries the client draft and the Conversation revision it was based
// on. Generation acceptance is deliberately a complete typed operation: an
// omitted revision or draft must never fall through to an older request shape.
export const generationBody = t.Object({
	expectedRevision: t.Integer(),
	content: t.String(),
});

// Continue carries only the Conversation revision. The server derives the
// selected terminal Message and current Control pair from its snapshot.
export const continuationBody = t.Object({
	expectedRevision: t.Integer(),
});

export type ConversationCommandBody = Static<typeof conversationCommandBody>;
export type GenerationBody = Static<typeof generationBody>;
export type ContinuationBody = Static<typeof continuationBody>;

export const notFoundOutcome = t.Object({ outcome: t.Literal("not-found") });
export const invalidOutcome = t.Object({
	outcome: t.Literal("invalid"),
	reason: t.String(),
});
export const notPlayableOutcome = t.Object({
	outcome: t.Literal("not-playable"),
	reason: t.String(),
});
export const notRemovableOutcome = t.Object({
	outcome: t.Literal("not-removable"),
	reason: t.String(),
});
export const conversationConflict = t.Object({
	outcome: t.Literal("conflict"),
	expectedRevision: t.Integer(),
	actualRevision: t.Integer(),
	currentConversation: conversationSummary,
});
export const characterConflict = t.Object({
	outcome: t.Literal("conflict"),
	expectedRevision: t.Integer(),
	actualRevision: t.Integer(),
	currentCharacter: characterSnapshot,
});

export const generationAccepted = t.Object({
	outcome: t.Literal("accepted"),
	generationId: t.Integer(),
	conversationId: t.Integer(),
	messageId: t.Integer(),
	variantId: t.Integer(),
});

export const generationStartResponse = t.Union([
	generationAccepted,
	notFoundOutcome,
	t.Object({ outcome: t.Literal("conflict"), reason: t.String() }),
	notPlayableOutcome,
	invalidOutcome,
]);

export type GenerationAccepted = Static<typeof generationAccepted>;
export type GenerationStartResponse = Static<typeof generationStartResponse>;

export const generationStopped = t.Object({
	outcome: t.Literal("stopped"),
	generationId: t.Integer(),
	conversation: conversationSummary,
});

export const generationsStopped = t.Object({
	outcome: t.Literal("stopped"),
	generationIds: t.Array(t.Integer()),
	conversation: conversationSummary,
});

export type GenerationStopped = Static<typeof generationStopped>;
export type GenerationsStopped = Static<typeof generationsStopped>;
