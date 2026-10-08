import { recoverConversationConflict } from "./domain-error-recovery";
import { presentDomainError, type ResponseSchemas } from "./domain-error";
import type { Database } from "bun:sqlite";

import { Elysia, t } from "elysia";
import { Type } from "@sinclair/typebox";

import {
	ConversationNotFoundError,
	InvalidConversationCommandError,
	createConversationModule,
	deleteConversation,
	type ConversationAction,
	type ConversationModule,
} from "../conversation";
import {
	createGenerationCoordinator,
	type GenerationCoordinatorOptions,
} from "../application/generation-coordinator";

import { conversationPromptPreset } from "../../shared/contract/prompt-preset";
import {
	addCharacterToCast,
	generationRuntimeFor,
	saveParticipantAsCharacter,
} from "../workflows";
import { toCharacterPayload } from "./character-library";
import { notFoundResponse } from "./responses";
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
	conversationDeleted,
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
	type GenerationTargetKind,
	historyPageQuery,
	messageIdParams,
	participantIdParams,
	saveParticipantAsCharacterBody,
	variantDetails,
	variantIdParams,
} from "../../shared/contract/conversation-schema";
import {
	createGenerationPreviewAsync,
	previewRecordFor,
	type GenerationPreviewAcceptanceFor,
} from "../workflows/generation-preview";
import { readMemorySourceAvailability } from "../conversation/generation-details";
import {
	macroVariables,
	macroVariablesAppliedResponse,
	macroVariablesEditBody,
	macroVariablesQuery,
} from "../../shared/contract/macro-variables";
import { createGenerationSubscriptionResponse } from "./generation-sse";
import {
	invalidOutcome,
	notFoundOutcome,
	notPlayableOutcome,
} from "../../shared/contract/outcomes";

const saveParticipantResponse = {
	200: characterAppliedResponse,
	409: conversationConflict,
	404: notFoundOutcome,
	422: invalidOutcome,
};

const addCastCharacterResponse = {
	200: conversationAppliedResponse,
	409: castCharacterConflict,
	404: notFoundOutcome,
	422: invalidOutcome,
};

const commandResponse = {
	200: conversationAppliedResponse,
	409: conversationCommandConflict,
	404: notFoundOutcome,
	422: invalidOutcome,
};

const siblingGenerationResponse = {
	200: generationAccepted,
	404: notFoundOutcome,
	409: notPlayableOutcome,
	422: invalidOutcome,
};

const macroVariablesEditResponse = {
	200: macroVariablesAppliedResponse,
	404: notFoundOutcome,
	409: conversationConflict,
	422: invalidOutcome,
};

const macroVariablesReadResponse = {
	200: macroVariables,
	404: notFoundOutcome,
	422: invalidOutcome,
};

const variantDetailsResponse = { 200: variantDetails, 404: notFoundOutcome, 422: invalidOutcome };

const generationInspectionResponse = { 200: activeGenerationDetails, 404: notFoundOutcome, 422: invalidOutcome };

const generationPreviewResponse = {
	200: generationPreview,
	404: notFoundOutcome,
	409: notPlayableOutcome,
	422: invalidOutcome,
};

const deleteResponse = {
	200: conversationDeleted,
	404: notFoundOutcome,
	422: invalidOutcome,
};

const readConversationOr404 = <T>(
	database: Database,
	read: (conversationModule: ConversationModule) => T | undefined,
): T | ReturnType<typeof notFoundResponse> => {
	const value = read(createConversationModule(database));
	return value === undefined ? notFoundResponse() : value;
};

// @approved
//  Send and Continue share one acceptance response contract.
const generationStartRouteResponse = {
	200: generationAccepted,
	404: notFoundOutcome,
	409: generationConflictResponse,
	422: invalidOutcome,
};

async function acceptanceResponse<S extends ResponseSchemas>(
	conversationId: number,
	start: () => Promise<{ readonly accepted: {
		readonly generationId: number;
		readonly messageId: number;
		readonly provisionalVariantId: number;
	} }>,
	responses: S,
) {
	try {
		const { accepted } = await start();
		return {
			outcome: "accepted" as const,
			generationId: accepted.generationId,
			conversationId,
			messageId: accepted.messageId,
			variantId: accepted.provisionalVariantId,
		};
	} catch (error) {
		return presentDomainError(error, responses);
	}
}

const previewUseFor = <K extends GenerationTargetKind>(
	database: Database,
	conversationId: number,
	kind: K,
	previewId: string | undefined,
	promptPlan: PromptPlan | undefined,
): GenerationPreviewAcceptanceFor<K> | undefined => {
	if (previewId === undefined) {
		if (promptPlan !== undefined) {
			throw new InvalidConversationCommandError("An edited Prompt Plan requires a preview token.");
		}
		return undefined;
	}
	const record = previewRecordFor(database, previewId, conversationId, kind);
	return {
		record,
		editedPlan: promptPlan ?? record.capture.plan.promptPlan,
	};
};

const currentConversationRevision = (
	database: Database,
	conversationId: number,
): number => {
	const revision = createConversationModule(database).getRevision(conversationId);
	if (revision === undefined) throw new ConversationNotFoundError(conversationId);
	return revision;
};

// @approved
//  Route options extend the Coordinator composition options, so the
// transport layer and the application share one options shape (transport
// fetch, checkpoint cadence, master key); the Coordinator resolves the deep
// Conversation module and the process runtime registry itself.
export interface ConversationRouteOptions extends GenerationCoordinatorOptions {}

export const createConversationRoutes = (
	database: Database,
	options: ConversationRouteOptions = {},
) => {
	const generationCoordinator = createGenerationCoordinator(database, options);

	return new Elysia()
		.delete(
			"/api/conversations/:id",
			({ params }) => {
				try {
					deleteConversation(database, params.id);
					return { outcome: "deleted" as const };
				} catch (error) {
					return presentDomainError(error, deleteResponse);
				}
			},
			{
				params: conversationIdParams,
				response: deleteResponse,
			},
		)
		.post(
			"/api/conversations/:id/generations/:generationId/stop",
			async ({ params }) => {
				const outcome = await generationCoordinator.stopGeneration(params.id, params.generationId);
				// @approved
				//  Durable truth wins: a committed interrupted transition always
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
			async ({ params, body }) => acceptanceResponse(
				params.id,
				() => generationCoordinator.startGeneration({
					conversationId: params.id,
					expectedRevision: body.previewId === undefined
						? body.expectedRevision
						: currentConversationRevision(database, params.id),
					formatting: { timeZone: body.timeZone, locale: body.locale },
					preview: previewUseFor(database, params.id, "continuation", body.previewId, body.promptPlan),
				}),
				generationStartRouteResponse,
			),
			{
				params: conversationIdParams,
				body: continuationBody,
				response: generationStartRouteResponse,
			},
		)
		.post(
			"/api/conversations/:id/generations/preview",
			async ({ params, body }) => {
				try {
					const common = {
						conversationId: params.id,
						formatting: { timeZone: body.timeZone, locale: body.locale },
						connectionSettings: options,
						preparationFetch: options.fetch,
					};
					const input = body.kind === "send"
						? { ...common, kind: body.kind, content: body.content }
						: body.kind === "sibling"
							? { ...common, kind: body.kind, messageId: body.messageId }
							: { ...common, kind: body.kind };
					const preview = await createGenerationPreviewAsync(database, input);
					const capture = preview.capture;
					const memoryActivation = capture.plan.memoryActivation;
					const memorySources = readMemorySourceAvailability(database, params.id, memoryActivation);
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
						pendingWrites: [...capture.macroWrites],
						loreActivation: capture.plan.loreActivation,
						memoryActivation,
						memorySources,
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
					return presentDomainError(error, generationPreviewResponse);
				}
			},
			{
				params: conversationIdParams,
				body: generationPreviewBody,
				response: generationPreviewResponse,
			},
		)
		.get(
			"/api/conversations/:id/generations/:generationId/inspection",
			({ params }) => {
				try {
					return readConversationOr404(database, (conversationModule) =>
						conversationModule.readActiveGenerationDetails(
							params.id,
							params.generationId,
						),
					);
				} catch (error) {
					return presentDomainError(error, generationInspectionResponse);
				}
			},
			{
				params: generationIdParams,
				response: generationInspectionResponse,
			},
		)
		.get(
			"/api/conversations/:id/messages/:messageId/variants/:variantId/details",
			({ params }) => {
				try {
					return readConversationOr404(database, (conversationModule) =>
						conversationModule.readVariantDetails(
							params.id,
							params.messageId,
							params.variantId,
						),
					);
				} catch (error) {
					return presentDomainError(error, variantDetailsResponse);
				}
			},
			{
				params: variantIdParams,
				response: variantDetailsResponse,
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
				const preset = createConversationModule(database).getPromptPreset(params.id);
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
					const variables = createConversationModule(database).readMacroVariables(params.id, {
							position: query.position,
							promptPresetId: query.promptPresetId,
						});
					return variables ?? status(404, { outcome: "not-found" as const });
				} catch (error) {
					return presentDomainError(error, macroVariablesReadResponse);
				}
			},
			{
				params: conversationIdParams,
				query: macroVariablesQuery,
				response: macroVariablesReadResponse,
			},
		)
		.post(
			"/api/conversations/:id/macro-variables",
			({ params, body }) => {
				try {
					const edited = createConversationModule(database).editMacroVariables({
							conversationId: params.id,
							expectedRevision: body.expectedRevision,
							promptPresetId: body.promptPresetId,
							position: body.position,
							operation: body.operation,
							name: body.name,
							value: body.operation === "set" ? body.value : undefined,
						});
					return { outcome: "applied" as const, ...edited };
				} catch (error) {
					return presentDomainError(error,
						macroVariablesEditResponse,
						recoverConversationConflict(() => createConversationModule(database).getSummary(params.id)));
				}
			},
			{
				params: conversationIdParams,
				body: macroVariablesEditBody,
				response: macroVariablesEditResponse,
			},
		)
		.get(
			"/api/conversations/:id/history",
			({ params, query }) =>
				readConversationOr404(database, (conversationModule) =>
					conversationModule.readHistory(params.id, {
						page: query.page,
						aroundMessageId: query.aroundMessageId,
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
				const settings = createConversationModule(database).getGenerationSettings(params.id);
				if (settings === undefined) {
					return status(404, { outcome: "not-found" as const });
				}
				// @approved
				//  The module read returns a fresh plain object in the canonical
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
			async ({ params, body }) => acceptanceResponse(
				params.id,
				() => generationCoordinator.startGeneration({
					conversationId: params.id,
					expectedRevision: body.previewId === undefined
						? body.expectedRevision
						: currentConversationRevision(database, params.id),
					content: body.content,
					formatting: { timeZone: body.timeZone, locale: body.locale },
					preview: previewUseFor(database, params.id, "send", body.previewId, body.promptPlan),
				}),
				generationStartRouteResponse,
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
					return notFoundResponse();
				}
				return createGenerationSubscriptionResponse(runtime, query.after ?? 0, request);
			},
			{
				params: generationIdParams,
				query: generationEventsQuery,
				response: t.Any(),
			},
		)
		// @approved
		//  A targeted Swipe creates one server-owned Provisional Variant
		// on an existing Message. The request is only an observer;
		// closing it never aborts the sibling provider attempt.
		.post(
			"/api/conversations/:id/messages/:messageId/sibling/generations",
			async ({ params, body }) =>
				acceptanceResponse(
					params.id,
					() => generationCoordinator.startGeneration({
						conversationId: params.id,
						messageId: params.messageId,
						formatting: { timeZone: body?.timeZone, locale: body?.locale },
						preview: body?.previewId === undefined
							? undefined
							: previewUseFor(database, params.id, "sibling", body.previewId, body.promptPlan),
					}),
					siblingGenerationResponse,
				),
				{
					params: messageIdParams,
					body: Type.Optional(siblingGenerationBody),
					response: siblingGenerationResponse,
				},
		)
		// @approved
		//  Revisioned Conversation commands remain separate from the
		// server-owned Generation acceptance and event routes above.
		.post(
			"/api/conversations/:id/commands",
			({ params, body }) => {
				try {
					// @approved
					//  SAFETY: Elysia validates the discriminated command shape at this
					// boundary; the Conversation domain then validates generation values
					// before persistence and keeps the action vocabulary closed.
					const action = body.action as ConversationAction;
					const conversation = createConversationModule(database).execute({
							conversationId: params.id,
							expectedRevision: body.expectedRevision,
							action,
						});
					return {
						outcome: "applied" as const,
						conversation: toConversationSummary(conversation),
					};
				} catch (error) {
					return presentDomainError(error,
						commandResponse,
						recoverConversationConflict(() => createConversationModule(database).getSummary(params.id)));
				}
			},
			{
				params: conversationIdParams,
				body: conversationCommandBody,
				response: commandResponse,
			},
		)
		.post(
			"/api/conversations/:id/cast/characters",
			({ params, body }) => {
				try {
					const conversation = addCharacterToCast(database, {
							conversationId: params.id,
							expectedConversationRevision: body.expectedConversationRevision,
							characterId: body.characterId,
							expectedCharacterRevision: body.expectedCharacterRevision,
						});
					return {
						outcome: "applied" as const,
						conversation: toConversationSummary(conversation),
					};
				} catch (error) {
					return presentDomainError(error,
						addCastCharacterResponse,
						recoverConversationConflict(() => createConversationModule(database).getSummary(params.id)));
				}
			},
			{
				params: conversationIdParams,
				body: addCharacterToCastBody,
				response: addCastCharacterResponse,
			},
		)
		.post(
			"/api/conversations/:id/cast/participants/:participantId/characters",
			({ params, body }) => {
				try {
					const { character } = saveParticipantAsCharacter(database, {
							conversationId: params.id,
							expectedConversationRevision:
								body.expectedConversationRevision,
							participantId: params.participantId,
						});
					return {
						outcome: "applied" as const,
						character: toCharacterPayload(character),
					};
				} catch (error) {
					return presentDomainError(error,
						saveParticipantResponse,
						recoverConversationConflict(() => createConversationModule(database).getSummary(params.id)));
				}
			},
			{
				params: participantIdParams,
				body: saveParticipantAsCharacterBody,
				response: saveParticipantResponse,
			},
		);
};
