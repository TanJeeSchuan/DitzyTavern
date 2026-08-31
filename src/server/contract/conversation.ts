import type { Database } from "bun:sqlite";
import { Elysia, status, t } from "elysia";
import {
	CharacterNotFoundError,
	InvalidCharacterDefinitionError,
	StaleCharacterRevisionError,
} from "../character-library";
import {
	ConversationNotFoundError,
	ConversationNotPlayableError,
	InvalidConversationCommandError,
	ParticipantNotFoundError,
	ParticipantNotRemovableError,
	createConversationModule,
	StaleConversationRevisionError,
	type ConversationAction,
	type ConversationGenerationSettings,
} from "../conversation";
import {
	createGenerationCoordinator,
	type GenerationCoordinatorOptions,
} from "../application/generation-coordinator";
import { openDatabase, withDatabase } from "../database/database";
import {
	addCharacterToCast,
	generationRuntimeFor,
	defaultGenerationRuntime,
	saveParticipantAsCharacter,
} from "../workflows";
import { toCharacterPayload } from "./character-library";
import {
	invalidResponse,
	notFoundResponse,
	staleCharacterConflictResponse,
	toConversationSummary,
} from "./payload";
import {
	activeGenerationDetails,
	addCharacterToCastBody,
	castCharacterConflict,
	characterAppliedResponse,
	chatHistoryPage,
	conversationAppliedResponse,
	conversationCommandBody,
	conversationCommandConflict,
	conversationConflict,
	conversationGenerationSettings,
	conversationIdParams,
	conversationSummary,
	continuationBody,
	generationAccepted,
	generationBody,
	generationConflictResponse,
	generationEventsQuery,
	generationIdParams,
	generationStopped,
	generationsStopped,
	historyPageQuery,
	messageIdParams,
	participantIdParams,
	saveParticipantAsCharacterBody,
	variantDetails,
	variantIdParams,
} from "../../shared/contract/conversation-schema";
import {
	generationAcceptanceResponse,
} from "./generation-error-mapping";
import { createGenerationSubscriptionResponse } from "./generation-sse";
import {
	invalidOutcome,
	notFoundOutcome,
	notPlayableOutcome,
} from "../../shared/contract/outcomes";

const runtimeRegistryForRequest = (connection: Database, configuredDatabase: Database | undefined) =>
	configuredDatabase === undefined ? defaultGenerationRuntime() : generationRuntimeFor(connection);

// Builds the typed stale-revision recovery shared by every Conversation
// route: the authoritative summary is re-read and returned inside the 409
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

// Maps a stale Conversation revision onto the typed recovery response: the
// authoritative summary rides inside the 409, or a 404 when the Conversation
// disappeared between the conflict and the recovery read.
const staleConversationResponse = (
	database: Database | undefined,
	conversationId: number,
	error: StaleConversationRevisionError,
) => {
	const conflict = staleConversationConflict(database, conversationId, error);
	return conflict.outcome === "not-found"
		? status(404, { outcome: "not-found" as const })
		: status(409, conflict);
};

// Send and Continue share one acceptance response contract.
const generationStartRouteResponse = {
	200: generationAccepted,
	404: notFoundOutcome,
	409: generationConflictResponse,
	422: invalidOutcome,
};

// Route options extend the Coordinator composition options, so transport
// tests can inject the Coordinator's Conversation and runtime lifecycle seams
// while production resolves the deep adapters itself.
export interface ConversationRouteOptions extends GenerationCoordinatorOptions {}

export const createConversationRoutes = (
	database: Database | undefined,
	options: ConversationRouteOptions = {},
) => {
	const generationCoordinator = createGenerationCoordinator(database, options);

	type GenerationAcceptanceStart = (
		conversationId: number,
		body: { expectedRevision: number; content?: string },
	) => Promise<{
		accepted: {
			generationId: number;
			modelMessageId: number;
			provisionalVariantId: number;
		};
	}>;

	// Send and Continue share one acceptance skeleton. Elysia validates the
	// route-specific body schema before this handler, so `content` is present
	// only for Send and the coordinator call receives exactly its own shape.
	const generationAcceptanceRoute = (start: GenerationAcceptanceStart) =>
		async ({ params, body }: {
			params: { id: number };
			body: { expectedRevision: number; content?: string };
		}) => {
			return generationAcceptanceResponse(
				params.id,
				() => start(params.id, body),
				(accepted) => accepted.modelMessageId,
				(failure) => {
					switch (failure.status) {
						case 404: return status(404, failure.body);
						case 409: return status(409, failure.body);
						case 422: return status(422, failure.body);
					}
				},
			);
		};

	const readActiveGenerationDetailsRoute = ({ params }: {
		params: { id: number; generationId: number };
	}) => {
		const details = withDatabase(database, (connection) =>
			createConversationModule(connection).readActiveGenerationDetails(
				params.id,
				params.generationId,
			),
		);
		if (details === undefined) return status(404, { outcome: "not-found" as const });
		return details;
	};

	const activeGenerationDetailsRouteOptions = {
		params: generationIdParams,
		response: { 200: activeGenerationDetails, 404: notFoundOutcome },
	};

	return new Elysia()
		.post(
			"/api/conversations/:id/generations/:generationId/stop",
			async ({ params }) => {
				const outcome = await generationCoordinator.stopGeneration(params.id, params.generationId);
				// Durable truth wins: a committed interrupted transition always
				// returns the authoritative Conversation snapshot, even when the
				// process runtime could not be settled.
				if (outcome.outcome === "stopped" || outcome.outcome === "incomplete-settlement") {
					return {
						outcome: "stopped" as const,
						generationId: outcome.generationId,
						conversation: toConversationSummary(outcome.conversation),
					};
				}
				// Missing, conflicting, and already-terminal targets share the
				// not-found transport outcome: the addressed Conversation has no
				// stoppable Generation at that id.
				return notFoundResponse();
			},
			{
				params: generationIdParams,
				response: {
					200: generationStopped,
					404: notFoundOutcome,
				},
			},
		)
		.post(
			"/api/conversations/:id/generations/stop-all",
			async ({ params }) => {
				const outcome = await generationCoordinator.stopAllGenerations(params.id);
				if (outcome.outcome === "stopped" || outcome.outcome === "incomplete-settlement") {
					return {
						outcome: "stopped" as const,
						generationIds: [...outcome.generationIds],
						conversation: toConversationSummary(outcome.conversation),
					};
				}
				return notFoundResponse();
			},
			{
				params: conversationIdParams,
				response: {
					200: generationsStopped,
					404: notFoundOutcome,
				},
			},
		)
		.post(
			"/api/conversations/:id/continue/generations",
			generationAcceptanceRoute((conversationId, body) =>
				generationCoordinator.startContinuationGeneration({
					conversationId,
					expectedRevision: body.expectedRevision,
				}),
			),
			{
				params: conversationIdParams,
				body: continuationBody,
				response: generationStartRouteResponse,
			},
		)
		.get(
			"/api/conversations/:id/generations/:generationId/inspection",
			readActiveGenerationDetailsRoute,
			activeGenerationDetailsRouteOptions,
		)
		// Details is a vocabulary-friendly alias used by Message/Generation
		// panels; both paths share the same bounded read semantics.
		.get(
			"/api/conversations/:id/generations/:generationId/details",
			readActiveGenerationDetailsRoute,
			activeGenerationDetailsRouteOptions,
		)
		.get(
			"/api/conversations/:id/messages/:messageId/variants/:variantId/details",
			({ params, status }) => {
				const details = withDatabase(database, (connection) =>
					createConversationModule(connection).readVariantDetails(
						params.id,
						params.messageId,
						params.variantId,
					),
				);
				if (details === undefined) return status(404, { outcome: "not-found" as const });
				return details;
			},
			{
				params: variantIdParams,
				response: { 200: variantDetails, 404: notFoundOutcome },
			},
		)
		.get(
			"/api/conversations/:id",
			({ params, status }) => {
				const conversation = withDatabase(database, (connection) =>
					createConversationModule(connection).getSnapshot(params.id),
				);
				if (conversation === undefined) {
					return status(404, { outcome: "not-found" as const });
				}
				return toConversationSummary(conversation);
			},
			{
				params: conversationIdParams,
				response: {
					200: conversationSummary,
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
				params: conversationIdParams,
				query: historyPageQuery,
				response: {
					200: chatHistoryPage,
					404: notFoundOutcome,
				},
			},
		)
		.get(
			"/api/conversations/:id/generation-settings",
			({ params, status }) => {
				const settings = withDatabase(database, (connection) =>
					createConversationModule(connection).getGenerationSettings(params.id),
				);
				if (settings === undefined) {
					return status(404, { outcome: "not-found" as const });
				}
				return toGenerationSettingsPayload(settings);
			},
			{
				params: conversationIdParams,
				response: {
					200: conversationGenerationSettings,
					404: notFoundOutcome,
				},
			},
		)
		.post(
			"/api/conversations/:id/generations",
			generationAcceptanceRoute((conversationId, body) => {
				if (body.content === undefined) {
					throw new InvalidConversationCommandError(
						"Generation start requires content and an expected Conversation revision.",
					);
				}
				return generationCoordinator.startSendGeneration({
					conversationId,
					expectedRevision: body.expectedRevision,
					content: body.content,
				});
			}),
			{
				params: conversationIdParams,
				body: generationBody,
				response: generationStartRouteResponse,
			},
		)
		.get(
			"/api/conversations/:id/generations/:generationId/events",
			({ params, query, request }) => {
				const connection = database ?? openDatabase();
				const runtime = runtimeRegistryForRequest(connection, database).get(params.generationId);
				if (runtime === undefined || runtime.state.conversationId !== params.id) {
					if (!database) connection.close();
					return new Response(JSON.stringify({ outcome: "not-found" }), {
						status: 404,
						headers: { "content-type": "application/json" },
					});
				}
				return createGenerationSubscriptionResponse(
					runtime,
					query.after ?? 0,
					request,
					() => { if (!database) connection.close(); },
				);
			},
			{
				params: generationIdParams,
				query: generationEventsQuery,
				response: t.Any(),
			},
		)
		// A targeted Swipe creates one server-owned Provisional Variant
		// on an existing Message. The request is only an observer;
		// closing it never aborts the sibling provider attempt.
		.post(
			"/api/conversations/:id/messages/:messageId/sibling/generations",
			async ({ params }) =>
				generationAcceptanceResponse(
					params.id,
					() => generationCoordinator.startSiblingGeneration({
						conversationId: params.id,
						messageId: params.messageId,
					}),
					(accepted) => accepted.messageId,
					(failure) => {
						// Sibling starts have no revision input, so a stale-revision
						// conflict remains an unexpected domain failure as before.
						if (failure.status === 409) {
							if (failure.body.outcome === "conflict") return undefined;
							return status(409, failure.body);
						}
						if (failure.status === 404) return status(404, failure.body);
						return status(422, failure.body);
					},
				),
			{
				params: messageIdParams,
				response: {
					200: generationAccepted,
					404: notFoundOutcome,
					409: notPlayableOutcome,
					422: invalidOutcome,
				},
			},
		)
		// Revisioned Conversation commands remain separate from the
		// server-owned Generation acceptance and event routes above.
		.post(
			"/api/conversations/:id/commands",
			({ params, body, status }) => {
				try {
					// SAFETY: Elysia validates the discriminated command shape at this
					// boundary; the Conversation domain then validates generation values
					// before persistence and keeps the action vocabulary closed.
					const action = body.action as ConversationAction;
					const conversation = withDatabase(database, (connection) =>
						createConversationModule(connection).execute({
							conversationId: params.id,
							expectedRevision: body.expectedRevision,
							action,
						}),
					);
					return {
						outcome: "applied" as const,
						conversation: toConversationSummary(conversation),
					};
				} catch (error) {
					if (error instanceof StaleConversationRevisionError) {
						return staleConversationResponse(database, params.id, error);
					}
					if (error instanceof ConversationNotFoundError) {
						return notFoundResponse();
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
						return invalidResponse(error.message);
					}
					throw error;
				}
			},
			{
				params: conversationIdParams,
				body: conversationCommandBody,
				response: {
					200: conversationAppliedResponse,
					409: conversationCommandConflict,
					404: notFoundOutcome,
					422: invalidOutcome,
				},
			},
		)
		.post(
			"/api/conversations/:id/cast/characters",
			({ params, body }) => {
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
						conversation: toConversationSummary(conversation),
					};
				} catch (error) {
					if (error instanceof StaleCharacterRevisionError) {
						return staleCharacterConflictResponse(error);
					}
					if (error instanceof StaleConversationRevisionError) {
						return staleConversationResponse(database, params.id, error);
					}
					if (
						error instanceof ConversationNotFoundError ||
						error instanceof CharacterNotFoundError
					) {
						return notFoundResponse();
					}
					if (error instanceof InvalidConversationCommandError) {
						return invalidResponse(error.message);
					}
					throw error;
				}
			},
			{
				params: conversationIdParams,
				body: addCharacterToCastBody,
				response: {
					200: conversationAppliedResponse,
					409: castCharacterConflict,
					404: notFoundOutcome,
					422: invalidOutcome,
				},
			},
		)
		.post(
			"/api/conversations/:id/cast/participants/:participantId/characters",
			({ params, body }) => {
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
						return staleConversationResponse(database, params.id, error);
					}
					if (
						error instanceof ConversationNotFoundError ||
						error instanceof ParticipantNotFoundError
					) {
						return notFoundResponse();
					}
					if (error instanceof InvalidCharacterDefinitionError) {
						return invalidResponse(error.message);
					}
					throw error;
				}
			},
			{
				params: participantIdParams,
				body: saveParticipantAsCharacterBody,
				response: {
					200: characterAppliedResponse,
					409: conversationConflict,
					404: notFoundOutcome,
					422: invalidOutcome,
				},
			},
		);
};

function toGenerationSettingsPayload(
	settings: ConversationGenerationSettings,
) {
	return {
		modelId: settings.modelId,
		temperature: settings.temperature,
		topP: settings.topP,
		frequencyPenalty: settings.frequencyPenalty,
		presencePenalty: settings.presencePenalty,
		contextLimit: settings.contextLimit,
				responseBudget: settings.responseBudget,
				safetyAllowance: settings.safetyAllowance,
				siblingGenerationLimit: settings.siblingGenerationLimit,
				continuationStrategy: settings.continuationStrategy,
				continuationInstruction: settings.continuationInstruction,
				continuationPrefillSuffix: settings.continuationPrefillSuffix,
		requestOverrides: {
			"chat-completions": { ...settings.requestOverrides["chat-completions"] },
			responses: { ...settings.requestOverrides.responses },
			"anthropic-messages": { ...settings.requestOverrides["anthropic-messages"] },
		},
	};
}
