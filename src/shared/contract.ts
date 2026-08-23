import type { Database } from "bun:sqlite";
import { Elysia, t } from "elysia";
import {
	CharacterNotFoundError,
	InvalidCharacterCommandError,
	InvalidCharacterDefinitionError,
	type CharacterSnapshot,
	StaleCharacterRevisionError,
	withCharacterLibrary,
} from "../server/character-library";
import {
	ConversationNotFoundError,
	ConversationNotPlayableError,
	InvalidConversationCommandError,
	InvalidConversationCreationError,
	ParticipantNotFoundError,
	type ConversationSnapshot,
	createConversationModule,
	StaleConversationRevisionError,
} from "../server/conversation";
import { getWorkspace } from "../server/database/workspace";
import { withDatabase } from "../server/database/database";
import {
	addCharacterToCast,
	createNativeConversation,
	saveParticipantAsCharacter,
} from "../server/workflows";

// Typed transport schemas mirror the Character Library seam's public types.
// Routes stay thin adapters: persistence and validation rules live behind
// the deep module, never here.

// Adapts the seam's immutable snapshot into the transport shape.
const toCharacterPayload = (character: CharacterSnapshot) => ({
	...character,
	openings: [...character.openings],
});

const chatSummary = t.Object({
	id: t.Integer(),
	name: t.String(),
	creationTime: t.String(),
	lastMessageTime: t.String(),
});

const characterSummary = t.Object({
	id: t.Integer(),
	name: t.String(),
});

const characterLibrarySummary = t.Object({
	id: t.Integer(),
	name: t.String(),
	revision: t.Integer(),
	pinned: t.Boolean(),
	preview: t.String(),
});

const characterPrompt = t.Object({
	systemInstruction: t.String(),
	identity: t.String(),
	scenario: t.String(),
	exampleDialogue: t.String(),
	postHistoryInstruction: t.String(),
});

const characterSnapshot = t.Object({
	id: t.Integer(),
	name: t.String(),
	revision: t.Integer(),
	pinned: t.Boolean(),
	prompt: characterPrompt,
	openings: t.Array(t.String()),
});

const createCommand = t.Object({
	type: t.Literal("create"),
	definition: t.Object({
		name: t.String(),
		prompt: characterPrompt,
		openings: t.Array(t.String()),
	}),
});

const renameCommand = t.Object({
	type: t.Literal("rename"),
	characterId: t.Integer(),
	expectedRevision: t.Integer(),
	name: t.String(),
});

const replacePromptCommand = t.Object({
	type: t.Literal("replace-prompt"),
	characterId: t.Integer(),
	expectedRevision: t.Integer(),
	prompt: characterPrompt,
});

const replaceOpeningsCommand = t.Object({
	type: t.Literal("replace-openings"),
	characterId: t.Integer(),
	expectedRevision: t.Integer(),
	openings: t.Array(t.String()),
});

const setPinnedCommand = t.Object({
	type: t.Literal("set-pinned"),
	characterId: t.Integer(),
	expectedRevision: t.Integer(),
	pinned: t.Boolean(),
});

const commandBodySchema = t.Union([
	createCommand,
	renameCommand,
	replacePromptCommand,
	replaceOpeningsCommand,
	setPinnedCommand,
]);

// Thin typed adapters over the Character Library seam. The database is
// injected so tests can mount the same routes against a temporary store;
// production passes undefined to use the default connection per request.
export const createCharacterLibraryRoutes = (database: Database | undefined) =>
	new Elysia()
		.get(
			"/api/characters",
			() => ({
				characters: withCharacterLibrary(database, (library) => library.list()),
			}),
			{
				response: t.Object({ characters: t.Array(characterLibrarySummary) }),
			},
		)
		.get(
			"/api/characters/:id",
			({ params, status }) => {
				const character = withCharacterLibrary(database, (library) =>
					library.get(params.id),
				);
				if (character === undefined) {
					return status(404, { outcome: "not-found" as const });
				}
				return toCharacterPayload(character);
			},
			{
				params: t.Object({ id: t.Numeric() }),
				response: {
					200: characterSnapshot,
					404: t.Object({ outcome: t.Literal("not-found") }),
				},
			},
		)
		.post(
			"/api/characters/commands",
			({ body, status }) => {
				try {
					const character = withCharacterLibrary(database, (library) =>
						library.execute(body),
					);
					return {
						outcome: "applied" as const,
						character: toCharacterPayload(character),
					};
				} catch (error) {
					if (error instanceof StaleCharacterRevisionError) {
						return status(409, {
							outcome: "conflict" as const,
							expectedRevision: error.expectedRevision,
							actualRevision: error.actualRevision,
							currentCharacter: toCharacterPayload(error.currentCharacter),
						});
					}
					if (error instanceof CharacterNotFoundError) {
						return status(404, { outcome: "not-found" as const });
					}
					if (
						error instanceof InvalidCharacterDefinitionError ||
						error instanceof InvalidCharacterCommandError
					) {
						return status(422, {
							outcome: "invalid" as const,
							reason: error.message,
						});
					}
					throw error;
				}
			},
			{
				body: commandBodySchema,
				response: {
					200: t.Object({
						outcome: t.Literal("applied"),
						character: characterSnapshot,
					}),
					409: t.Object({
						outcome: t.Literal("conflict"),
						expectedRevision: t.Integer(),
						actualRevision: t.Integer(),
						currentCharacter: characterSnapshot,
					}),
					404: t.Object({ outcome: t.Literal("not-found") }),
					422: t.Object({ outcome: t.Literal("invalid"), reason: t.String() }),
				},
			},
		);

const participantPrompt = t.Object({
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

const conversationVariant = t.Object({
	id: t.Integer(),
	position: t.Integer(),
	content: t.String(),
	timestamp: t.String(),
	selected: t.Boolean(),
	data: t.Array(
		t.Object({
			namespace: t.String(),
			key: t.String(),
			value: t.String(),
		}),
	),
});

const conversationMessage = t.Object({
	id: t.Integer(),
	position: t.Integer(),
	timestamp: t.String(),
	author: t.Nullable(
		t.Object({
			participantId: t.Nullable(t.Integer()),
			capturedName: t.Nullable(t.String()),
		}),
	),
	historicalContext: t.Nullable(
		t.Object({
			humanParticipantId: t.Integer(),
			modelParticipantId: t.Integer(),
		}),
	),
	variants: t.Array(conversationVariant),
	data: t.Array(
		t.Object({
			namespace: t.String(),
			key: t.String(),
			value: t.String(),
		}),
	),
});

const conversationSnapshot = t.Object({
	id: t.Integer(),
	name: t.String(),
	revision: t.Integer(),
	cast: t.Array(castParticipant),
	control: conversationControl,
	controlValidity: conversationControlValidity,
	playable: t.Boolean(),
	capabilities: t.Object({
		compose: capabilityAvailability,
		generate: capabilityAvailability,
		swipe: capabilityAvailability,
	}),
	messages: t.Array(conversationMessage),
	data: t.Array(
		t.Object({
			namespace: t.String(),
			key: t.String(),
			value: t.String(),
		}),
	),
});

// Adapts the seam's immutable snapshot into the transport shape: the
// Conversation seam returns readonly arrays, while the typed response
// contract declares mutable ones. Mirrors toCharacterPayload above.
const toConversationPayload = (conversation: ConversationSnapshot) => ({
	...conversation,
	cast: conversation.cast.map((participant) => ({
		...participant,
		openings: [...participant.openings],
	})),
	messages: conversation.messages.map((message) => ({
		...message,
		variants: message.variants.map((variant) => ({
			...variant,
			data: [...variant.data],
		})),
		data: [...message.data],
	})),
	data: [...conversation.data],
});

// Builds the typed stale-revision recovery shared by every Conversation
// route: the authoritative snapshot is re-read and returned inside the 409
// conflict payload, or a 404 when the Conversation disappeared in the
// meantime. One helper keeps error mapping from drifting between the
// command, fork, and save-as-Character workflow routes.
const staleConversationConflict = (
	database: Database | undefined,
	conversationId: number,
	error: StaleConversationRevisionError,
):
	| { outcome: "not-found" }
	| {
			outcome: "conflict";
			expectedRevision: number;
			actualRevision: number;
			currentConversation: ReturnType<typeof toConversationPayload>;
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
		currentConversation: toConversationPayload(current),
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
]);

// The revision is part of the Conversation command; the conversation id
// lives in the route path.
const conversationCommandBody = t.Object({
	expectedRevision: t.Integer(),
	action: conversationCommandAction,
});

const notFoundOutcome = t.Object({ outcome: t.Literal("not-found") });
const invalidOutcome = t.Object({
	outcome: t.Literal("invalid"),
	reason: t.String(),
});
const notPlayableOutcome = t.Object({
	outcome: t.Literal("not-playable"),
	reason: t.String(),
});
const conversationConflict = t.Object({
	outcome: t.Literal("conflict"),
	expectedRevision: t.Integer(),
	actualRevision: t.Integer(),
	currentConversation: conversationSnapshot,
});
const characterConflict = t.Object({
	outcome: t.Literal("conflict"),
	expectedRevision: t.Integer(),
	actualRevision: t.Integer(),
	currentCharacter: characterSnapshot,
});

const newChatSeatSchema = t.Union([
	t.Object({
		type: t.Literal("character"),
		characterId: t.Integer(),
		expectedRevision: t.Integer(),
	}),
	t.Object({
		type: t.Literal("adhoc"),
		definition: t.Object({
			name: t.String(),
			prompt: participantPrompt,
			openings: t.Array(t.String()),
		}),
	}),
]);

export const createNativeConversationRoutes = (database: Database | undefined) =>
	new Elysia().post(
		"/api/conversations/native",
		({ body, status }) => {
			try {
				const conversation = withDatabase(database, (connection) =>
					createNativeConversation(connection, {
						name: body.name,
						humanSeat: body.humanSeat,
						modelSeat: body.modelSeat,
					}),
				);
				return {
					outcome: "created" as const,
					conversation: toConversationPayload(conversation),
				};
			} catch (error) {
				if (error instanceof StaleCharacterRevisionError) {
					return status(409, {
						outcome: "conflict" as const,
						expectedRevision: error.expectedRevision,
						actualRevision: error.actualRevision,
						currentCharacter: toCharacterPayload(error.currentCharacter),
					});
				}
				if (error instanceof CharacterNotFoundError) {
					return status(404, { outcome: "not-found" as const });
				}
				if (
					error instanceof InvalidCharacterDefinitionError ||
					error instanceof InvalidConversationCreationError
				) {
					return status(422, {
						outcome: "invalid" as const,
						reason: error.message,
					});
				}
				throw error;
			}
		},
		{
			body: t.Object({
				name: t.String(),
				humanSeat: newChatSeatSchema,
				modelSeat: newChatSeatSchema,
			}),
			response: {
				200: t.Object({
					outcome: t.Literal("created"),
					conversation: conversationSnapshot,
				}),
				409: t.Object({
					outcome: t.Literal("conflict"),
					expectedRevision: t.Integer(),
					actualRevision: t.Integer(),
					currentCharacter: characterSnapshot,
				}),
				404: t.Object({ outcome: t.Literal("not-found") }),
				422: t.Object({
					outcome: t.Literal("invalid"),
					reason: t.String(),
				}),
			},
		},
	);

// Thin typed adapters over the deep Conversation seam: snapshot reads,
// revisioned command execution, and the explicit Character-to-Cast workflow
// (which itself composes Character Library and Conversation capabilities in
// one transaction). Routes never coordinate tables or reproduce domain
// rules; they map typed outcomes to typed transport results.
export const createConversationRoutes = (database: Database | undefined) =>
	new Elysia()
		.get(
			"/api/conversations/:id",
			({ params, status }) => {
				const conversation = withDatabase(database, (connection) =>
					createConversationModule(connection).getSnapshot(params.id),
				);
				if (conversation === undefined) {
					return status(404, { outcome: "not-found" as const });
				}
				return toConversationPayload(conversation);
			},
			{
				params: t.Object({ id: t.Numeric() }),
				response: {
					200: conversationSnapshot,
					404: notFoundOutcome,
				},
			},
		)
		.post(
			"/api/conversations/:id/commands",
			({ params, body, status }) => {
				try {
					const conversation = withDatabase(database, (connection) =>
						createConversationModule(connection).execute({
							conversationId: params.id,
							expectedRevision: body.expectedRevision,
							action: body.action,
						}),
					);
					return {
						outcome: "applied" as const,
						conversation: toConversationPayload(conversation),
					};
				} catch (error) {
					if (error instanceof StaleConversationRevisionError) {
						const conflict = staleConversationConflict(
							database,
							params.id,
							error,
						);
						if (conflict.outcome === "not-found") {
							return status(404, conflict);
						}
						return status(409, conflict);
					}
					if (error instanceof ConversationNotFoundError) {
						return status(404, { outcome: "not-found" as const });
					}
					if (error instanceof ConversationNotPlayableError) {
						return status(409, {
							outcome: "not-playable" as const,
							reason: error.message,
						});
					}
					if (error instanceof InvalidConversationCommandError) {
						return status(422, {
							outcome: "invalid" as const,
							reason: error.message,
						});
					}
					throw error;
				}
			},
			{
				params: t.Object({ id: t.Numeric() }),
				body: conversationCommandBody,
				response: {
					200: t.Object({
						outcome: t.Literal("applied"),
						conversation: conversationSnapshot,
					}),
					409: t.Union([conversationConflict, notPlayableOutcome]),
					404: notFoundOutcome,
					422: invalidOutcome,
				},
			},
		)
		.post(
			"/api/conversations/:id/cast/characters",
			({ params, body, status }) => {
				try {
					const conversation = withDatabase(database, (connection) =>
						addCharacterToCast(connection, {
							conversationId: params.id,
							expectedConversationRevision: body.expectedConversationRevision,
							characterId: body.characterId,
							expectedCharacterRevision: body.expectedCharacterRevision,
						}),
					);
					return {
						outcome: "applied" as const,
						conversation: toConversationPayload(conversation),
					};
				} catch (error) {
					if (error instanceof StaleCharacterRevisionError) {
						return status(409, {
							outcome: "conflict" as const,
							expectedRevision: error.expectedRevision,
							actualRevision: error.actualRevision,
							currentCharacter: toCharacterPayload(error.currentCharacter),
						});
					}
					if (error instanceof StaleConversationRevisionError) {
						const conflict = staleConversationConflict(
							database,
							params.id,
							error,
						);
						if (conflict.outcome === "not-found") {
							return status(404, conflict);
						}
						return status(409, conflict);
					}
					if (
						error instanceof ConversationNotFoundError ||
						error instanceof CharacterNotFoundError
					) {
						return status(404, { outcome: "not-found" as const });
					}
					if (error instanceof InvalidConversationCommandError) {
						return status(422, {
							outcome: "invalid" as const,
							reason: error.message,
						});
					}
					throw error;
				}
			},
			{
				params: t.Object({ id: t.Numeric() }),
				body: t.Object({
					expectedConversationRevision: t.Integer(),
					characterId: t.Integer(),
					expectedCharacterRevision: t.Integer(),
				}),
				response: {
					200: t.Object({
						outcome: t.Literal("applied"),
						conversation: conversationSnapshot,
					}),
					409: t.Union([characterConflict, conversationConflict]),
					404: notFoundOutcome,
					422: invalidOutcome,
				},
			},
		)
		.post(
			"/api/conversations/:id/cast/participants/:participantId/characters",
			({ params, body, status }) => {
				try {
					const { character } = withDatabase(database, (connection) =>
						saveParticipantAsCharacter(connection, {
							conversationId: params.id,
							expectedConversationRevision:
								body.expectedConversationRevision,
							participantId: params.participantId,
						}),
					);
					return {
						outcome: "applied" as const,
						character: toCharacterPayload(character),
					};
				} catch (error) {
					if (error instanceof StaleConversationRevisionError) {
						const conflict = staleConversationConflict(
							database,
							params.id,
							error,
						);
						if (conflict.outcome === "not-found") {
							return status(404, conflict);
						}
						return status(409, conflict);
					}
					if (
						error instanceof ConversationNotFoundError ||
						error instanceof ParticipantNotFoundError
					) {
						return status(404, { outcome: "not-found" as const });
					}
					if (error instanceof InvalidCharacterDefinitionError) {
						return status(422, {
							outcome: "invalid" as const,
							reason: error.message,
						});
					}
					throw error;
				}
			},
			{
				params: t.Object({ id: t.Numeric(), participantId: t.Numeric() }),
				body: t.Object({
					expectedConversationRevision: t.Integer(),
				}),
				response: {
					200: t.Object({
						outcome: t.Literal("applied"),
						character: characterSnapshot,
					}),
					409: conversationConflict,
					404: notFoundOutcome,
					422: invalidOutcome,
				},
			},
		);

export const contract = new Elysia()
	.get("/api/health", () => ({ ok: true }), {
		response: t.Object({ ok: t.Boolean() }),
	})
	.get("/api/workspace", () => getWorkspace(), {
		response: t.Object({
			activeChatId: t.Nullable(t.Integer()),
			chats: t.Array(chatSummary),
			characters: t.Array(characterSummary),
		}),
	})
	.use(createCharacterLibraryRoutes(undefined))
	.use(createNativeConversationRoutes(undefined))
	.use(createConversationRoutes(undefined));

export type Contract = typeof contract;
