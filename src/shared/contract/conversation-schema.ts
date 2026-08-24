import type { Database } from "bun:sqlite";
import { t } from "elysia";
import {
	type ConversationSnapshot,
	createConversationModule,
	type StaleConversationRevisionError,
} from "../../server/conversation";
import { withDatabase } from "../../server/database/database";
import { characterSnapshot } from "./character-library";

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
});

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
	addParticipantAction,
	renameParticipantAction,
	replaceParticipantPromptAction,
	replaceParticipantOpeningsAction,
	assignControlAction,
	removeParticipantAction,
]);

// The revision is part of the Conversation command; the conversation id
// lives in the route path.
export const conversationCommandBody = t.Object({
	expectedRevision: t.Integer(),
	action: conversationCommandAction,
});

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

