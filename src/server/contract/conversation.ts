import type { Database } from "bun:sqlite";
import { Elysia, status, t } from "elysia";
import { Type } from "@sinclair/typebox";
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
	type ConversationModule,
} from "../conversation";
import {
	createGenerationCoordinator,
	type GenerationCoordinatorOptions,
} from "../application/generation-coordinator";
import { withDatabase } from "../database/database";
import { conversationPromptPreset } from "../../shared/contract/prompt-preset";
import {
	addCharacterToCast,
	generationRuntimeFor,
	saveParticipantAsCharacter,
} from "../workflows";
import { toCharacterPayload } from "./character-library";
import { invalidResponse, notFoundResponse, staleCharacterConflictResponse } from "./responses";
import { toConversationSummary } from "./projections";
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
	siblingGenerationBody,
	type PromptPlan,
	generationAccepted,
	generationBody,
	generationPreview,
	generationPreviewBody,
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
	createGenerationPreview,
	previewRecordFor,
} from "../workflows/generation-preview";
import {
	macroVariables,
	macroVariablesAppliedResponse,
	macroVariablesEditBody,
	macroVariablesQuery,
} from "../../shared/contract/macro-variables";
import {
	generationAcceptanceResponse,
	siblingGenerationAcceptanceResponse,
} from "./generation-error-mapping";
import { createGenerationSubscriptionResponse } from "./generation-sse";
import {
	invalidOutcome,
	notFoundOutcome,
	notPlayableOutcome,
} from "../../shared/contract/outcomes";

const withConversationModule = <T>(
	database: Database | undefined,
	operation: (conversationModule: ConversationModule) => T,
): T =>
	withDatabase(database, (connection) =>
		operation(createConversationModule(connection)),
	);

const readConversationOr404 = <T>(
	database: Database | undefined,
	read: (conversationModule: ConversationModule) => T | undefined,
): T | ReturnType<typeof notFoundResponse> => {
	const value = withConversationModule(database, read);
	return value === undefined ? notFoundResponse() : value;
};

// ==[HUMAN APPROVED]== Builds the typed stale-revision recovery shared by every Conversation
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
	const current = withConversationModule(database, (conversationModule) =>
		conversationModule.getSummary(conversationId),
	);
	if (current === undefined) {
		// ==[HUMAN APPROVED]== The Conversation disappeared between the conflict and the recovery
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

// ==[HUMAN APPROVED]== Maps a stale Conversation revision onto the typed recovery response: the
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

// ==[HUMAN APPROVED]== Send and Continue share one acceptance response contract.
const generationStartRouteResponse = {
	200: generationAccepted,
	404: notFoundOutcome,
	409: generationConflictResponse,
	422: invalidOutcome,
};

const previewUseFor = (
	database: Database | undefined,
	conversationId: number,
	kind: "send" | "continuation" | "sibling",
	previewId: string | undefined,
	promptPlan: PromptPlan | undefined,
) => {
	if (previewId === undefined) {
		if (promptPlan !== undefined) {
			throw new InvalidConversationCommandError("An edited Prompt Plan requires a preview token.");
		}
		return undefined;
	}
	const record = previewRecordFor(previewId, conversationId);
	if (record.capture.kind !== kind) {
		throw new InvalidConversationCommandError("The Prompt Plan preview intent does not match this Generation.");
	}
	return {
		record,
		editedPlan: promptPlan ?? record.capture.capture.plan.promptPlan,
	};
};

const currentConversationRevision = (
	database: Database | undefined,
	conversationId: number,
): number => {
	const revision = withConversationModule(database, (conversationModule) =>
		conversationModule.getRevision(conversationId),
	);
	if (revision === undefined) throw new ConversationNotFoundError(conversationId);
	return revision;
};

// ==[HUMAN APPROVED]== Route options extend the Coordinator composition options, so transport
// tests can inject the Coordinator's Conversation and runtime lifecycle seams
// while production resolves the deep adapters itself.
export interface ConversationRouteOptions extends GenerationCoordinatorOptions {}

export const createConversationRoutes = (
	database: Database | undefined,
	options: ConversationRouteOptions = {},
) => {
	const generationCoordinator = createGenerationCoordinator(database, options);

	return new Elysia()
		.post(
			"/api/conversations/:id/generations/:generationId/stop",
			async ({ params }) => {
				const outcome = await generationCoordinator.stopGeneration(params.id, params.generationId);
				// ==[HUMAN APPROVED]== Durable truth wins: a committed interrupted transition always
				// returns the authoritative Conversation snapshot, even when the
				// process runtime could not be settled. Anything that stopped
				// nothing is not-found: the addressed Conversation has no
				// stoppable Generation at that id.
				if (outcome.outcome !== "stopped") return notFoundResponse();
				return {
					outcome: "stopped" as const,
					generationId: outcome.generationId,
					conversation: toConversationSummary(outcome.conversation),
				};
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
				if (outcome.outcome !== "stopped") return notFoundResponse();
				return {
					outcome: "stopped" as const,
					generationIds: [...outcome.generationIds],
					conversation: toConversationSummary(outcome.conversation),
				};
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
			async ({ params, body }) => generationAcceptanceResponse(
				params.id,
				() => generationCoordinator.startContinuationGeneration({
					conversationId: params.id,
					expectedRevision: body.previewId === undefined
						? body.expectedRevision
						: currentConversationRevision(database, params.id),
					formatting: { timeZone: body.timeZone, locale: body.locale },
					preview: previewUseFor(database, params.id, "continuation", body.previewId, body.promptPlan),
				}),
			),
			{
				params: conversationIdParams,
				body: continuationBody,
				response: generationStartRouteResponse,
			},
		)
		.post(
			"/api/conversations/:id/generations/preview",
			({ params, body }) => {
				try {
					const preview = withDatabase(database, (connection) => createGenerationPreview(connection, {
						conversationId: params.id,
						kind: body.kind,
						content: body.content,
						messageId: body.messageId,
						formatting: { timeZone: body.timeZone, locale: body.locale },
						connectionSettings: options,
					}));
					const capture = preview.capture.capture;
					return {
						outcome: "available" as const,
						previewId: preview.id,
						conversationId: preview.conversationId,
						kind: preview.capture.kind,
						promptPlan: capture.plan.promptPlan,
						participants: {
							human: capture.humanParticipant,
							model: { id: capture.author.participantId, name: capture.author.capturedName },
						},
						effectiveSettings: capture.plan.effectiveSettings,
						pendingWrites: capture.macroWrites.map((write) => {
							if (write.value === undefined) return { name: write.name, operation: write.operation };
							return { name: write.name, operation: write.operation, value: write.value };
						}),
						budget: {
							tokenEstimate: capture.plan.budget.tokenEstimate,
							responseBudget: capture.plan.budget.responseBudget,
							safetyAllowance: capture.plan.budget.safetyAllowance,
							contextLimit: capture.plan.budget.contextLimit,
							totalRequiredTokens: capture.plan.budget.totalRequiredTokens,
							budgetFits: capture.plan.budget.fits,
						},
					};
				} catch (error) {
					if (error instanceof ConversationNotFoundError) return notFoundResponse();
					if (error instanceof InvalidConversationCommandError) return invalidResponse(error.message);
					throw error;
				}
			},
			{
				params: conversationIdParams,
				body: generationPreviewBody,
				response: { 200: generationPreview, 404: notFoundOutcome, 422: invalidOutcome },
			},
		)
		.get(
			"/api/conversations/:id/generations/:generationId/inspection",
			({ params }) =>
				readConversationOr404(database, (conversationModule) =>
					conversationModule.readActiveGenerationDetails(
						params.id,
						params.generationId,
					),
				),
			{
				params: generationIdParams,
				response: { 200: activeGenerationDetails, 404: notFoundOutcome },
			},
		)
		.get(
			"/api/conversations/:id/messages/:messageId/variants/:variantId/details",
			({ params }) =>
				readConversationOr404(database, (conversationModule) =>
					conversationModule.readVariantDetails(
						params.id,
						params.messageId,
						params.variantId,
					),
				),
			{
				params: variantIdParams,
				response: { 200: variantDetails, 404: notFoundOutcome },
			},
		)
		.get(
			"/api/conversations/:id",
			({ params }) =>
				readConversationOr404(database, (conversationModule) => {
					return conversationModule.getSummary(params.id);
				}),
			{
				params: conversationIdParams,
				response: {
					200: conversationSummary,
					404: notFoundOutcome,
				},
			},
		)
		.get(
			"/api/conversations/:id/prompt-preset",
			({ params }) => {
				const preset = withDatabase(database, (connection) =>
					createConversationModule(connection).getPromptPreset(params.id),
				);
				return preset ?? notFoundResponse();
			},
			{
				params: conversationIdParams,
				response: {
					200: conversationPromptPreset,
					404: notFoundOutcome,
				},
			},
		)
		.get(
			"/api/conversations/:id/macro-variables",
			({ params, query, status }) => {
				try {
					const variables = withConversationModule(database, (conversationModule) =>
						conversationModule.readMacroVariables(params.id, {
							position: query.position,
							promptPresetId: query.promptPresetId,
						}),
					);
					return variables ?? status(404, { outcome: "not-found" as const });
				} catch (error) {
					if (error instanceof InvalidConversationCommandError) {
						return invalidResponse(error.message);
					}
					throw error;
				}
			},
			{
				params: conversationIdParams,
				query: macroVariablesQuery,
				response: {
					200: macroVariables,
					404: notFoundOutcome,
					422: invalidOutcome,
				},
			},
		)
		.post(
			"/api/conversations/:id/macro-variables",
			({ params, body, status }) => {
				try {
					const edited = withDatabase(database, (connection) =>
						createConversationModule(connection).editMacroVariables({
							conversationId: params.id,
							expectedRevision: body.expectedRevision,
							promptPresetId: body.promptPresetId,
							position: body.position,
							operation: body.operation,
							name: body.name,
							value: body.operation === "set" ? body.value : undefined,
						}),
					);
					return { outcome: "applied" as const, ...edited };
				} catch (error) {
					if (error instanceof StaleConversationRevisionError) {
						return staleConversationResponse(database, params.id, error);
					}
					if (error instanceof ConversationNotFoundError) return notFoundResponse();
					if (error instanceof InvalidConversationCommandError) {
						return status(422, { outcome: "invalid" as const, reason: error.message });
					}
					throw error;
				}
			},
			{
				params: conversationIdParams,
				body: macroVariablesEditBody,
				response: {
					200: macroVariablesAppliedResponse,
					404: notFoundOutcome,
					409: conversationConflict,
					422: invalidOutcome,
				},
			},
		)
		.get(
			"/api/conversations/:id/history",
			({ params, query }) =>
				readConversationOr404(database, (conversationModule) =>
					conversationModule.readHistory(params.id, {
						page: query.page,
						pageSize: query.pageSize,
					}),
				),
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
				const settings = withConversationModule(database, (conversationModule) =>
					conversationModule.getGenerationSettings(params.id),
				);
				if (settings === undefined) {
					return status(404, { outcome: "not-found" as const });
				}
				// ==[HUMAN APPROVED]== The module read returns a fresh plain object in the canonical
				// Generation Settings vocabulary; the response schema is the derived
				// transport clone, so no field-by-field payload projection sits here.
				return settings;
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
			async ({ params, body }) => generationAcceptanceResponse(
				params.id,
				() => generationCoordinator.startSendGeneration({
					conversationId: params.id,
					expectedRevision: body.previewId === undefined
						? body.expectedRevision
						: currentConversationRevision(database, params.id),
					content: body.content,
					formatting: { timeZone: body.timeZone, locale: body.locale },
					preview: previewUseFor(database, params.id, "send", body.previewId, body.promptPlan),
				}),
			),
			{
				params: conversationIdParams,
				body: generationBody,
				response: generationStartRouteResponse,
			},
		)
		.get(
			"/api/conversations/:id/generations/:generationId/events",
			({ params, query, request }) => {
				const runtime = generationRuntimeFor(database).get(params.generationId);
				if (runtime === undefined || runtime.state.conversationId !== params.id) {
					return new Response(JSON.stringify({ outcome: "not-found" }), {
						status: 404,
						headers: { "content-type": "application/json" },
					});
				}
				return createGenerationSubscriptionResponse(runtime, query.after ?? 0, request);
			},
			{
				params: generationIdParams,
				query: generationEventsQuery,
				response: t.Any(),
			},
		)
		// ==[HUMAN APPROVED]== A targeted Swipe creates one server-owned Provisional Variant
		// on an existing Message. The request is only an observer;
		// closing it never aborts the sibling provider attempt.
		.post(
			"/api/conversations/:id/messages/:messageId/sibling/generations",
			async ({ params, body }) =>
				siblingGenerationAcceptanceResponse(
					params.id,
					() => generationCoordinator.startSiblingGeneration({
						conversationId: params.id,
						messageId: params.messageId,
						formatting: { timeZone: body?.timeZone, locale: body?.locale },
						preview: body?.previewId === undefined
							? undefined
							: previewUseFor(database, params.id, "sibling", body.previewId, body.promptPlan),
					}),
				),
				{
					params: messageIdParams,
					body: Type.Optional(siblingGenerationBody),
					response: {
						200: generationAccepted,
						404: notFoundOutcome,
						409: notPlayableOutcome,
						422: invalidOutcome,
					},
				},
		)
		// ==[HUMAN APPROVED]== Revisioned Conversation commands remain separate from the
		// server-owned Generation acceptance and event routes above.
		.post(
			"/api/conversations/:id/commands",
			({ params, body, status }) => {
				try {
					// ==[HUMAN APPROVED]== SAFETY: Elysia validates the discriminated command shape at this
					// boundary; the Conversation domain then validates generation values
					// before persistence and keeps the action vocabulary closed.
					const action = body.action as ConversationAction;
					const conversation = withConversationModule(database, (conversationModule) =>
						conversationModule.execute({
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
