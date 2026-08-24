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
	ParticipantNotRemovableError,
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
import { defaultArtifactDirectory } from "../server/artifact";
import {
	StagedChatImportDuplicateConfirmationError,
	StagedChatImportExpiredError,
	StagedChatImportPlanError,
	StagedChatImportTokenMismatchError,
	StagedChatImportUnavailableError,
	SillyTavernImportError,
	withChatImport,
	withChatImportDetails,
} from "../server/sillytavern";

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
	// Global provenance reference count so pickers and lists present
	// deletion impact without one detail request per row.
	provenanceReferenceCount: t.Integer(),
});

const characterPrompt = t.Object({
	systemInstruction: t.String(),
	identity: t.String(),
	scenario: t.String(),
	exampleDialogue: t.String(),
	postHistoryInstruction: t.String(),
});

const characterDeletionMode = t.Union([
	t.Literal("hard-delete"),
	t.Literal("tombstone"),
]);

// Derived deletion impact presented with every authoritative read so the
// confirmation flow can show the exact consequence before any command.
const characterDeletionImpact = t.Object({
	provenanceReferenceCount: t.Integer(),
	deletionMode: characterDeletionMode,
});

const characterSnapshot = t.Object({
	id: t.Integer(),
	name: t.String(),
	revision: t.Integer(),
	pinned: t.Boolean(),
	prompt: characterPrompt,
	openings: t.Array(t.String()),
	deletionImpact: characterDeletionImpact,
});

// Outcome of a confirmed deletion: the mode is derived from the reference
// count at command time, never guessed by the client.
const characterDeletionResult = t.Object({
	characterId: t.Integer(),
	deletionMode: characterDeletionMode,
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

// Confirmed deletion. The expected revision guards against deleting a
// Character whose impact the caller has not seen; the outcome derives the
// deletion mode from the current reference count.
const deleteCommand = t.Object({
	type: t.Literal("delete"),
	characterId: t.Integer(),
	expectedRevision: t.Integer(),
});

const commandBodySchema = t.Union([
	createCommand,
	renameCommand,
	replacePromptCommand,
	replaceOpeningsCommand,
	setPinnedCommand,
	deleteCommand,
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
					const outcome = withCharacterLibrary(database, (library) =>
						library.execute(body),
					);
					// A confirmed deletion returns the typed result rather than a
					// snapshot and neither stays readable; every other command
					// returns the authoritative updated Character. DeletionMode is
					// exclusive to the result, so the discriminant keeps the two
					// applied payloads distinct.
					if ("deletionMode" in outcome) {
						return {
							outcome: "applied" as const,
							result: {
								characterId: outcome.characterId,
								deletionMode: outcome.deletionMode,
							},
						};
					}
					return {
						outcome: "applied" as const,
						character: toCharacterPayload(outcome),
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
					200: t.Union([
						t.Object({
							outcome: t.Literal("applied"),
							character: characterSnapshot,
						}),
						t.Object({
							outcome: t.Literal("applied"),
							result: characterDeletionResult,
						}),
					]),
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
	// Derived historical display state: whether the authoring Participant is
	// still an active Cast member. The captured name keeps displaying with a
	// no-longer-in-Cast marker after removal.
	author: t.Nullable(
		t.Object({
			participantId: t.Nullable(t.Integer()),
			capturedName: t.Nullable(t.String()),
			inCast: t.Boolean(),
		}),
	),
	historicalContext: t.Nullable(
		t.Object({
			humanParticipantId: t.Integer(),
			modelParticipantId: t.Integer(),
		}),
	),
	// Derived per-Message targeted Swipe eligibility: new sibling Variant
	// generation requires a playable Conversation, a captured historical
	// Control pair, and usable Definitions for both historical Participants.
	swipe: t.Object({
		eligible: t.Boolean(),
		reason: t.Union([
			t.Literal("conversation-not-playable"),
			t.Literal("missing-historical-context"),
			t.Literal("historical-participant-unavailable"),
			t.Null(),
		]),
	}),
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

const chatHistoryPage = t.Object({
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
const notRemovableOutcome = t.Object({
	outcome: t.Literal("not-removable"),
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
		.get(
			"/api/conversations/:id/history",
			({ params, query, status }) => {
				const history = withDatabase(database, (connection) =>
					createConversationModule(connection).readHistory(params.id, {
						page: query.page,
						pageSize: query.pageSize,
					}),
				);
				if (history === undefined) {
					return status(404, { outcome: "not-found" as const });
				}
				return history;
			},
			{
				params: t.Object({ id: t.Numeric() }),
				query: t.Object({
					page: t.Optional(t.Numeric()),
					pageSize: t.Optional(t.Numeric()),
				}),
				response: {
					200: chatHistoryPage,
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
					if (error instanceof ParticipantNotRemovableError) {
						return status(409, {
							outcome: "not-removable" as const,
							reason: error.reason,
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
					409: t.Union([conversationConflict, notPlayableOutcome, notRemovableOutcome]),
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

const importSuggestion = t.Object({
	characterId: t.Integer(),
	name: t.String(),
	match: t.Union([
		t.Literal("exact"),
		t.Literal("case-insensitive"),
		t.Literal("fuzzy"),
	]),
	// The strongest suggestion is always pre-filled but unconfirmed; final
	// review cannot pass until the user approves it.
	confirmed: t.Boolean(),
});

const importGroup = t.Object({
	key: t.String(),
	isBlank: t.Boolean(),
	messagePositions: t.Array(t.Integer()),
	// Parallel per-Message Variant counts for inspection and split selection.
	messageVariantCounts: t.Array(t.Integer()),
	messageCount: t.Integer(),
	variantCount: t.Integer(),
	participantNameDefault: t.String(),
	suggestion: t.Nullable(importSuggestion),
});

const importDuplicateMatch = t.Object({
	id: t.Integer(),
	name: t.String(),
});

// The staged preview contract mirrors the deep SillyTavern Import module's
// public preview; routes only transport it.
const chatImportPreview = t.Object({
	title: t.String(),
	originalFilename: t.String(),
	sha256: t.String(),
	byteLength: t.Integer(),
	integrity: t.Nullable(t.String()),
	counts: t.Object({
		messages: t.Integer(),
		variants: t.Integer(),
	}),
	warnings: t.Array(t.String()),
	groups: t.Array(importGroup),
	duplicates: t.Object({
		exact: t.Array(importDuplicateMatch),
		related: t.Array(importDuplicateMatch),
	}),
});

const stagedOutcome = t.Object({
	outcome: t.Literal("staged"),
	token: t.String(),
	preview: chatImportPreview,
});

// User-confirmed resolution plan for the commit: three outcomes only, whole
// Messages referenced by 1-based record positions, and a nonblank native
// name per Participant (derived from the selected Profile for forks).
const importResolutionOutcome = t.Union([
	t.Object({
		type: t.Literal("fork"),
		characterId: t.Integer(),
	}),
	t.Object({ type: t.Literal("new-character") }),
	t.Object({ type: t.Literal("chat-only") }),
]);

const importResolvedParticipant = t.Object({
	name: t.String(),
	outcome: importResolutionOutcome,
	messagePositions: t.Array(t.Integer()),
});

const chatImportCommitBody = t.Object({
	// The SHA-256 the client already knows from the preview; only the exact
	// staged bytes that produced the preview may be committed.
	sha256: t.String(),
	title: t.String(),
	// Explicit Import another copy confirmation, required for exact
	// duplicates (matching raw-byte SHA-256); related-source matches stay
	// advisory.
	duplicateConfirmed: t.Boolean(),
	participants: t.Array(importResolvedParticipant),
});

// Receipt participant outcome labels: existing Profile fork, new Profile
// creation, or a complete Chat-only Participant.
const importReceiptParticipant = t.Object({
	name: t.String(),
	outcome: t.Union([
		t.Literal("fork"),
		t.Literal("new-character"),
		t.Literal("chat-only"),
	]),
	sourceCharacterId: t.Nullable(t.Integer()),
});

// Compact post-commit receipt; the committed Conversation is returned too so
// the client can open the new Chat immediately without a round trip.
const chatImportReceipt = t.Object({
	conversationId: t.Integer(),
	title: t.String(),
	originalFilename: t.String(),
	sha256: t.String(),
	byteLength: t.Integer(),
	counts: t.Object({
		messages: t.Integer(),
		variants: t.Integer(),
	}),
	participants: t.Array(importReceiptParticipant),
	warnings: t.Array(t.String()),
	duplicates: t.Object({
		exact: t.Array(importDuplicateMatch),
		related: t.Array(importDuplicateMatch),
	}),
});

const commitOutcome = t.Object({
	outcome: t.Literal("committed"),
	conversation: conversationSnapshot,
	receipt: chatImportReceipt,
});

// Derived, never stored: whether the physical exact-source copy currently
// satisfies the committed metadata. Missing or corrupt files report cleaned
// up so provenance loss never makes the native Chat look corrupt.
const importDetailsArtifactAvailability = t.Union([
	t.Object({ status: t.Literal("available") }),
	t.Object({
		status: t.Literal("cleaned-up"),
		reason: t.Union([t.Literal("missing"), t.Literal("corrupt")]),
	}),
]);

const importDetailsArtifact = t.Object({
	chatId: t.Integer(),
	namespace: t.String(),
	key: t.String(),
	relativePath: t.String(),
	originalFilename: t.String(),
	mediaType: t.String(),
	byteLength: t.Integer(),
	sha256: t.String(),
	availability: importDetailsArtifactAvailability,
});

// The complete Import Details payload: the persisted receipt and source
// identity, structured duplicate evidence, and exact-artifact availability.
// Heavy provenance (archive text, reasoning, signatures, exact bytes) is
// never part of this contract; exact bytes load only through the download
// route.
const chatImportDetails = t.Object({
	conversationId: t.Integer(),
	title: t.String(),
	receipt: t.Object({
		originalFilename: t.String(),
		sha256: t.String(),
		byteLength: t.Nullable(t.Integer()),
		integrity: t.Nullable(t.String()),
		counts: t.Object({
			messages: t.Integer(),
			variants: t.Integer(),
		}),
		warnings: t.Array(t.String()),
		importerVersion: t.String(),
	}),
	duplicates: t.Object({
		exact: t.Array(importDuplicateMatch),
		related: t.Array(importDuplicateMatch),
	}),
	artifact: t.Nullable(importDetailsArtifact),
});

// Thin typed adapters over the deep staged Chat import seam. The stage
// route deliberately declares no body schema: Elysia must leave the raw
// request stream untouched so the module can stream the uploaded bytes into
// managed temporary storage exactly once instead of buffering the artifact.
// The preview and discard routes stay tiny mappings of typed outcomes.
export const createChatImportRoutes = (
	database: Database | undefined,
	artifactDirectory: string,
) =>
	new Elysia()
		.post(
			"/api/imports/chats/stage",
			async ({ request, status }) => {
				const originalFilename =
					request.headers.get("x-import-filename") ?? "";
				if (originalFilename === "") {
					return status(422, {
						outcome: "invalid" as const,
						reason: "A file name is required with this upload.",
					});
				}
				const body = request.body;
				if (body === null) {
					return status(422, {
						outcome: "invalid" as const,
						reason: "The upload body is empty.",
					});
				}
				try {
					const result = await withChatImport(
						database,
						artifactDirectory,
						(chatImport) =>
							chatImport.stageFile({
								bytes: body,
								originalFilename,
							}),
					);
					return { outcome: "staged" as const, ...result };
				} catch (error) {
					if (error instanceof SillyTavernImportError) {
						return status(422, {
							outcome: "invalid" as const,
							reason: error.message,
						});
					}
					throw error;
				}
			},
			{
				response: {
					200: stagedOutcome,
					422: invalidOutcome,
				},
			},
		)
		.post(
			"/api/imports/chats/:token/preview",
			({ params, body, status }) => {
				try {
					const preview = withChatImport(
						database,
						artifactDirectory,
						(chatImport) =>
							chatImport.preview(params.token, body.sha256),
					);
					return { outcome: "available" as const, preview };
				} catch (error) {
					if (error instanceof StagedChatImportExpiredError) {
						return status(410, { outcome: "expired" as const });
					}
					if (error instanceof StagedChatImportUnavailableError) {
						return status(410, {
							outcome: "unavailable" as const,
							reason: error.reason,
						});
					}
					if (error instanceof StagedChatImportTokenMismatchError) {
						return status(422, {
							outcome: "invalid" as const,
							reason: error.message,
						});
					}
					throw error;
				}
			},
			{
				params: t.Object({ token: t.String() }),
				body: t.Object({ sha256: t.String() }),
				response: {
					200: t.Object({
						outcome: t.Literal("available"),
						preview: chatImportPreview,
					}),
					410: t.Union([
						t.Object({ outcome: t.Literal("expired") }),
						t.Object({
							outcome: t.Literal("unavailable"),
							reason: t.Union([
								t.Literal("missing"),
								t.Literal("corrupt"),
							]),
						}),
					]),
					422: invalidOutcome,
				},
			},
		)
		.post(
			"/api/imports/chats/:token/commit",
			({ params, body, status }) => {
				try {
					const result = withChatImport(
						database,
						artifactDirectory,
						(chatImport) =>
							chatImport.commit(params.token, {
								sha256: body.sha256,
								title: body.title,
								duplicateConfirmed: body.duplicateConfirmed,
								participants: body.participants,
							}),
					);
					return {
						outcome: "committed" as const,
						conversation: toConversationPayload(result.conversation),
						receipt: result.receipt,
					};
				} catch (error) {
					if (error instanceof StagedChatImportExpiredError) {
						return status(410, { outcome: "expired" as const });
					}
					if (error instanceof StagedChatImportUnavailableError) {
						return status(410, {
							outcome: "unavailable" as const,
							reason: error.reason,
						});
					}
					if (
						error instanceof StagedChatImportTokenMismatchError ||
						error instanceof StagedChatImportPlanError ||
						error instanceof StagedChatImportDuplicateConfirmationError ||
						error instanceof SillyTavernImportError ||
						error instanceof CharacterNotFoundError ||
						error instanceof InvalidCharacterDefinitionError ||
						error instanceof InvalidCharacterCommandError ||
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
				params: t.Object({ token: t.String() }),
				body: chatImportCommitBody,
				response: {
					200: commitOutcome,
					410: t.Union([
						t.Object({ outcome: t.Literal("expired") }),
						t.Object({
							outcome: t.Literal("unavailable"),
							reason: t.Union([
								t.Literal("missing"),
								t.Literal("corrupt"),
							]),
						}),
					]),
					422: invalidOutcome,
				},
			},
		)
		.post(
			"/api/imports/chats/:token/discard",
			({ params }) => {
				// Discard is idempotent: unknown and already-discarded handles
				// report the same removed outcome without touching anything.
				withChatImport(database, artifactDirectory, (chatImport) =>
					chatImport.discard(params.token),
				);
				return { outcome: "discarded" as const };
			},
			{
				params: t.Object({ token: t.String() }),
				response: {
					200: t.Object({ outcome: t.Literal("discarded") }),
				},
			},
		)
		.get(
			"/api/conversations/:id/import-details",
			({ params, status }) => {
				const details = withChatImportDetails(
					database,
					artifactDirectory,
					(importDetails) => importDetails.importDetails(params.id),
				);
				if (details === undefined) {
					// Either the Chat is missing or it carries no import
					// provenance; the client treats both as "no Import Details".
					return status(404, { outcome: "not-found" as const });
				}
				return details;
			},
			{
				params: t.Object({ id: t.Numeric() }),
				response: {
					200: chatImportDetails,
					404: notFoundOutcome,
				},
			},
		)
		.get(
			"/api/conversations/:id/import-source",
			({ params, status }) => {
				const result = withChatImportDetails(
					database,
					artifactDirectory,
					(importDetails) =>
						importDetails.downloadExactSource(params.id),
				);
				if (result === undefined) {
					return status(404, { outcome: "not-found" as const });
				}
				if (result.status === "cleaned-up") {
					// Missing or corrupt exact artifacts are described as cleaned
					// up and disable only exact download; normal Chat reading and
					// every Conversation command stay available.
					return status(410, {
						outcome: "cleaned-up" as const,
						reason: result.reason,
					});
				}
				// The exact managed bytes stream verbatim; only response metadata
				// (media type and the sanitized original leaf filename) derives
				// from the stored artifact.
				return new Response(new Uint8Array(result.bytes), {
					headers: {
						"content-type": result.artifact.mediaType,
						"content-disposition": result.contentDisposition,
						"content-length": String(result.bytes.length),
					},
				});
			},
			{
				params: t.Object({ id: t.Numeric() }),
				response: {
					404: notFoundOutcome,
					410: t.Object({
						outcome: t.Literal("cleaned-up"),
						reason: t.Union([
							t.Literal("missing"),
							t.Literal("corrupt"),
						]),
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
	.use(createNativeConversationRoutes(undefined))
	.use(createConversationRoutes(undefined))
	.use(createChatImportRoutes(undefined, defaultArtifactDirectory()));

export type Contract = typeof contract;
