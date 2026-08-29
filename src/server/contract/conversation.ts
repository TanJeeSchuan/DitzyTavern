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
	SiblingVariantUnavailableError,
	InvalidConversationCommandError,
	ContinuationUnavailableError,
	ParticipantNotFoundError,
	ParticipantNotRemovableError,
	createConversationModule,
	stopConversationGeneration,
	stopConversationGenerations,
	StaleConversationRevisionError,
	type ConversationAction,
	type ConversationGenerationSettings,
} from "../conversation";
import { PromptBudgetExceededError } from "../prompt-compiler";
import type { ConnectionSettingsModuleOptions } from "../connection-settings";
import type { ModelFetch } from "../model-client";
import {
	createGenerationCoordinator,
	GenerationConfigurationError,
} from "../application/generation-coordinator";
import { openDatabase, withDatabase } from "../database/database";
import {
	addCharacterToCast,
	generationRuntimeFor,
	defaultGenerationRuntime,
	type GenerationRuntimeState,
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
	invalidOutcome,
	notFoundOutcome,
	notPlayableOutcome,
} from "../../shared/contract/outcomes";

type GenerationRuntimeValue = ReturnType<ReturnType<typeof generationRuntimeFor>["get"]>;

const runtimeRegistryForRequest = (connection: Database, configuredDatabase: Database | undefined) =>
	configuredDatabase === undefined ? defaultGenerationRuntime() : generationRuntimeFor(connection);

type GenerationStartFailure =
	| { readonly status: 404; readonly body: { readonly outcome: "not-found" } }
	| { readonly status: 409; readonly body: { readonly outcome: "not-playable"; readonly reason: string } }
	| { readonly status: 409; readonly body: { readonly outcome: "conflict"; readonly reason: string } }
	| { readonly status: 422; readonly body: { readonly outcome: "invalid"; readonly reason: string } };

/**
 * Map only errors that are part of the Generation acceptance contract. An
 * unexpected Error must reach the framework's 500 handling instead of being
 * presented as a client-correctable invalid request.
 */
const generationStartFailure = (error: Error): GenerationStartFailure | undefined => {
	if (error instanceof ConversationNotFoundError) {
		return { status: 404, body: { outcome: "not-found" } };
	}
	if (error instanceof ConversationNotPlayableError) {
		return { status: 409, body: { outcome: "not-playable", reason: error.message } };
	}
	if (error instanceof StaleConversationRevisionError) {
		return { status: 409, body: { outcome: "conflict", reason: error.message } };
	}
	if (
		error instanceof ContinuationUnavailableError ||
		error instanceof GenerationConfigurationError ||
		error instanceof InvalidConversationCommandError ||
		error instanceof PromptBudgetExceededError ||
		error instanceof SiblingVariantUnavailableError
	) {
		return { status: 422, body: { outcome: "invalid", reason: error.message } };
	}
	return undefined;
};
const activeGenerationPayload = (state: GenerationRuntimeState) => ({
	outcome: "active-state" as const,
	generationId: state.generationId,
	conversationId: state.conversationId,
	messageId: state.messageId,
	variantId: state.variantId,
	content: state.content,
	reasoning: state.reasoning,
	latestEventId: state.latestEventId,
	status: state.status,
	terminalReason: state.terminalReason,
});

const terminalGenerationFrame = (state: GenerationRuntimeState) =>
	state.status === "complete"
		? {
			type: "complete",
			data: {
				outcome: "applied" as const,
				generationId: state.generationId,
				latestEventId: state.latestEventId,
			},
		}
		: state.status === "stopped"
			? {
				type: "stopped",
				data: { outcome: "stopped" as const, generationId: state.generationId },
			}
			: {
				type: "error",
				data: { outcome: "failed" as const, reason: state.terminalReason ?? "Generation failed." },
			};

function createGenerationSubscriptionResponse(
	runtime: NonNullable<GenerationRuntimeValue>,
	afterEventId: number,
	request: Request,
	onClosed?: () => void,
): Response {
	const encoder = new TextEncoder();
	const frame = (type: string, data: GenerationSsePayload, eventId?: number) =>
		`${eventId === undefined ? "" : `id: ${eventId}\n`}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			let subscription: ReturnType<typeof runtime.subscribe> | undefined;
			let removeStateListener: (() => void) | undefined;
			const emit = (type: string, data: GenerationSsePayload, eventId?: number) => {
				if (closed) return;
				try { controller.enqueue(encoder.encode(frame(type, data, eventId))); } catch { /* client disconnected */ }
			};
			const finish = (state: GenerationRuntimeState) => {
				if (closed || state.status === "active") return;
				subscription?.close();
				removeStateListener?.();
				const terminal = terminalGenerationFrame(state);
				emit(terminal.type, terminal.data);
				closed = true;
				try { controller.close(); } catch { /* client disconnected */ }
				onClosed?.();
			};
			subscription = runtime.subscribe(
				afterEventId,
				(envelope) => emit("generation", envelope.event, envelope.eventId),
				(state) => emit("state", activeGenerationPayload(state)),
			);
			removeStateListener = runtime.onStateChange(finish);
			finish(runtime.state);
			request.signal.addEventListener("abort", () => {
				if (closed) return;
				closed = true;
				subscription?.close();
				removeStateListener?.();
				onClosed?.();
			}, { once: true });
		},
	});
	return new Response(stream, {
		headers: {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive",
		},
	});
}

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

// Builds the typed accepted-generation body shared by the Send, Continue,
// and Swipe acceptance routes.
const acceptedGenerationBody = (
	conversationId: number,
	generationId: number,
	messageId: number,
	variantId: number,
) => ({
	outcome: "accepted" as const,
	generationId,
	conversationId,
	messageId,
	variantId,
});

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

// Thin typed adapters over the deep Conversation seam: snapshot reads,
// revisioned command execution, and the explicit Character-to-Cast workflow
// (which itself composes Character Library and Conversation capabilities in
// one transaction). Routes never coordinate tables or reproduce domain
// rules; they map typed outcomes to typed transport results.
export interface ConversationRouteOptions extends ConnectionSettingsModuleOptions {
	readonly fetch?: ModelFetch;
}

type GenerationSsePayload =
	| import("../model-client").ModelClientEvent
	| { readonly outcome: "applied"; readonly generationId?: number; readonly latestEventId?: number }
	| { readonly outcome: "failed"; readonly reason: string }
	| { readonly outcome: "stopped"; readonly generationId: number }
	| {
			readonly outcome: "active-state";
			readonly generationId: number;
			readonly conversationId: number;
			readonly messageId: number;
			readonly variantId: number;
			readonly content: string;
			readonly reasoning: string;
			readonly latestEventId: number;
			readonly status: "active" | "complete" | "stopped" | "failed";
			readonly terminalReason: string | null;
		};

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
			try {
				const started = await start(params.id, body);
				const accepted = started.accepted;
				return acceptedGenerationBody(
					params.id,
					accepted.generationId,
					accepted.modelMessageId,
					accepted.provisionalVariantId,
				);
			} catch (error) {
				const failure = error instanceof Error ? generationStartFailure(error) : undefined;
				if (failure?.status === 404) return status(404, failure.body);
				if (failure?.status === 409) return status(409, failure.body);
				if (failure?.status === 422) return status(422, failure.body);
				throw error;
			}
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
			({ params, status }) => {
				const connection = database ?? openDatabase();
				let runtime: GenerationRuntimeValue;
				try {
					const registry = runtimeRegistryForRequest(connection, database);
					runtime = registry.get(params.generationId);
					if (runtime !== undefined && runtime.state.conversationId !== params.id) {
						return status(404, { outcome: "not-found" as const });
					}
					runtime?.stop();
					const conversation = stopConversationGeneration(connection, {
						conversationId: params.id,
						generationId: params.generationId,
					});
					runtime?.markStopped();
					return {
						outcome: "stopped" as const,
						generationId: params.generationId,
						conversation: toConversationSummary(conversation),
					};
				} catch (error) {
					if (error instanceof ConversationNotFoundError || error instanceof InvalidConversationCommandError) {
						runtime?.releaseStopRequest();
						return notFoundResponse();
					}
					throw error;
				} finally {
					if (!database) connection.close();
				}
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
			({ params }) => {
				const connection = database ?? openDatabase();
				try {
					const registry = runtimeRegistryForRequest(connection, database);
					// Checkpoint without aborting first. The Conversation transition below
					// owns the complete target set; runtimes are settled only after its
					// durable commit succeeds.
					registry.flushAll(params.id);
					const stopped = stopConversationGenerations(connection, {
						conversationId: params.id,
					});
					for (const generationId of stopped.generationIds) {
						const runtime = registry.get(generationId);
						if (runtime?.state.conversationId !== params.id) continue;
						runtime.stop();
						runtime.markStopped();
					}
					return {
						outcome: "stopped" as const,
						generationIds: stopped.generationIds,
						conversation: toConversationSummary(stopped.conversation),
					};
				} catch (error) {
					if (error instanceof ConversationNotFoundError || error instanceof InvalidConversationCommandError) {
						return notFoundResponse();
					}
					throw error;
				} finally {
					if (!database) connection.close();
				}
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
			async ({ params, status }) => {
				try {
					const started = await generationCoordinator.startSiblingGeneration({
						conversationId: params.id,
						messageId: params.messageId,
					});
				const accepted = started.accepted;
				return acceptedGenerationBody(
					params.id,
					accepted.generationId,
					accepted.messageId,
					accepted.provisionalVariantId,
				);
			} catch (error) {
				const failure = error instanceof Error ? generationStartFailure(error) : undefined;
				if (failure?.status === 404) return notFoundResponse();
				if (failure?.status === 409 && failure.body.outcome === "not-playable") return status(409, failure.body);
				if (failure?.status === 422) return invalidResponse(failure.body.reason);
				throw error;
			}
			},
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
