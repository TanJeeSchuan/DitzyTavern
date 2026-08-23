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
	InvalidConversationCreationError,
	type ConversationSnapshot,
} from "../server/conversation";
import { getWorkspace } from "../server/database/workspace";
import { withDatabase } from "../server/database/database";
import { createNativeConversation } from "../server/workflows";

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
});

const conversationControl = t.Object({
	humanParticipantId: t.Nullable(t.Integer()),
	modelParticipantId: t.Nullable(t.Integer()),
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
	.use(createNativeConversationRoutes(undefined));

export type Contract = typeof contract;
