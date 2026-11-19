import { drizzle } from "drizzle-orm/bun-sqlite";
import { forkConversation } from "../conversation";
import { chatBox, loadBoxVersion, withBoxOperations } from "../box/registry";
import { presentDomainError, type ResponseSchemas } from "./domain-error";
import {
	readConversationSummary,
	readConversationGenerationSettings,
	readActiveGenerationDetails,
	readVariantDetails,
	readConversationPromptPreset,
	readMacroVariables,
	editMacroVariables,
	readChatHistory,
	readVariantText,
	executeConversationCommand,
} from "../conversation";
import type { Database } from "bun:sqlite";

import { Elysia, t } from "elysia";

import {
	ConversationNotFoundError,
	InvalidConversationCommandError,
	deleteConversation,
	type ConversationAction,
} from "../conversation";
import {
	createGenerationCoordinator,
	type GenerationCoordinatorOptions,
} from "../application/generation-coordinator";

import { conversationPromptPresetQuery, conversationPromptPresetResponse } from "../../shared/contract/prompt-preset";
import {
	addCharacterToCast,
	generationRuntimeFor,
	saveParticipantAsCharacter,
} from "../workflows";
import { notFoundResponse } from "./responses";
import { toCharacterPayload, toConversationSummary } from "./projections";
import {
	addCharacterToCastResponse,
	chatHistoryResponse,
	conversationCommandResponse,
	conversationDeleteResponse,
	conversationForkResponse,
	conversationGenerationSettingsResponse,
	conversationReadResponse,
	generationInspectionResponse,
	generationPreviewResponse,
	generationStartResponse,
	generationStopResponse,
	generationsStopResponse,
	saveParticipantAsCharacterResponse,
	siblingGenerationResponse,
	variantDetailsResponse,
	variantTextResponse,
	addCharacterToCastBody,
	conversationCommandBody,
	forkConversationBody,
	conversationIdParams,
	continuationBody,
	siblingGenerationBody,
	type PromptPlan,
	generationBody,
	generationPreviewBody,
	generationEventsQuery,
	generationIdParams,
	historyPageQuery,
	messageIdParams,
	participantIdParams,
	saveParticipantAsCharacterBody,
	variantIdParams,
} from "../../shared/contract/conversation-schema";
import {
	createGenerationPreviewAsync,
	previewRecordFor,
	type GenerationPreviewAcceptance,
} from "../workflows/generation-preview";
import {
	macroVariablesEditResponse,
	macroVariablesReadResponse,
	macroVariablesEditBody,
	macroVariablesQuery,
} from "../../shared/contract/macro-variables";
import { generationSubscriptionEvents } from "./generation-sse";

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

const previewUseFor = (
	database: Database,
	conversationId: number,
	previewId: string | undefined,
	promptPlan: PromptPlan | undefined,
): GenerationPreviewAcceptance | undefined => {
	if (previewId === undefined) {
		if (promptPlan !== undefined) {
			throw new InvalidConversationCommandError("An edited Prompt Plan requires a preview token.");
		}
		return undefined;
	}
	const record = previewRecordFor(database, previewId, conversationId);
	return {
		record,
		editedPlan: promptPlan ?? record.capture.plan.promptPlan,
	};
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
					return presentDomainError(error, conversationDeleteResponse);
				}
			},
			{
				params: conversationIdParams,
				response: conversationDeleteResponse,
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
				response: generationStopResponse,
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
				response: generationsStopResponse,
			},
		)
		.post(
			"/api/conversations/:id/continue/generations",
			async ({ params, body }) => acceptanceResponse(
				params.id,
				() => generationCoordinator.startGeneration({
					conversationId: params.id,
					expectedRevision: body.previewId === undefined ? body.expectedRevision : undefined,
					formatting: { timeZone: body.timeZone, locale: body.locale },
					target: { kind: body.kind },
					preview: previewUseFor(database, params.id, body.previewId, body.promptPlan),
				}),
				generationStartResponse,
			),
			{
				params: conversationIdParams,
				body: continuationBody,
				response: generationStartResponse,
			},
		)
		.post(
			"/api/conversations/:id/generations/preview",
			async ({ params, body }) => {
				try {
					const settings = readConversationGenerationSettings(database, params.id);
					if (settings === undefined) throw new ConversationNotFoundError(params.id);
					const common = {
						connection: generationCoordinator.resolveTransport(database, settings.connectionProfileId, true)?.connection ?? null,
						conversationId: params.id,
						formatting: { timeZone: body.timeZone, locale: body.locale },
						connectionSettings: options,
						preparationFetch: options.fetch,
					};
					const input = body.kind === "send"
						? { ...common, kind: body.kind, content: body.content, moves: body.moves }
						: body.kind === "sibling"
							? { ...common, kind: body.kind, messageId: body.messageId, reroll: body.reroll }
							: { ...common, kind: body.kind };
					const preview = await createGenerationPreviewAsync(database, input);
					const capture = preview.capture;
					const { human, model } = capture.preparation.derivation;
					const { breakdown, fits } = capture.plan.budget;
					return {
						outcome: "available" as const,
						previewId: preview.id,
						conversationId: capture.preparation.conversationId,
						kind: capture.preparation.target.kind,
						promptPlan: capture.plan.promptPlan,
						participants: {
							human: { id: human.id, name: human.name },
							model: { id: model.id, name: model.name },
						},
						effectiveSettings: capture.plan.effectiveSettings,
						pendingWrites: [...capture.macroWrites],
						loreActivation: capture.plan.loreActivation,
						boxTraces: capture.plan.boxTraces,
						budget: {
							tokenEstimate: breakdown.tokenEstimate,
							responseBudget: breakdown.responseBudget,
							safetyAllowance: breakdown.safetyAllowance,
							contextLimit: breakdown.contextLimit,
							totalRequiredTokens: breakdown.totalRequiredTokens,
							budgetFits: fits,
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
					return readActiveGenerationDetails(database, params.id, params.generationId) ?? notFoundResponse();
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
			"/api/conversations/:id/messages/:messageId/variants/:variantId/text",
			({ params }) => readVariantText(database, params.id, params.messageId, params.variantId) ?? notFoundResponse(),
			{
				params: variantIdParams,
				response: variantTextResponse,
			},
		)
		.get(
			"/api/conversations/:id/messages/:messageId/variants/:variantId/details",
			({ params }) => {
				try {
					return readVariantDetails(database, params.id, params.messageId, params.variantId) ?? notFoundResponse();
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
				readConversationSummary(database, params.id) ?? notFoundResponse(),
			{
				params: conversationIdParams,
				response: conversationReadResponse,
			},
		)
		.get(
			"/api/conversations/:id/prompt-preset",
			({ params, query }) => {
				const preset = readConversationPromptPreset(database, params.id, query.presetId);
				return preset ?? notFoundResponse();
			},
			{
				params: conversationIdParams,
				query: conversationPromptPresetQuery,
				response: conversationPromptPresetResponse,
			},
		)
		.get(
			"/api/conversations/:id/macro-variables",
			({ params, query }) => {
				try {
					const variables = readMacroVariables(database, params.id, {
							position: query.position,
							promptPresetId: query.promptPresetId,
						});
					return variables ?? notFoundResponse();
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
					const edited = editMacroVariables(database, {
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
					return presentDomainError(error, macroVariablesEditResponse);
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
				readChatHistory(database, params.id, {
					page: query.page,
					aroundMessageId: query.aroundMessageId,
					pageSize: query.pageSize,
				}) ?? notFoundResponse(),
			{
				params: conversationIdParams,
				query: historyPageQuery,
				response: chatHistoryResponse,
			},
		)
		.get(
			"/api/conversations/:id/generation-settings",
			({ params }) => {
				const settings = readConversationGenerationSettings(database, params.id);
				if (settings === undefined) {
					return notFoundResponse();
				}
				// @approved
				//  The module read returns a fresh plain object in the canonical
				// Generation Settings vocabulary; the response schema is the derived
				// transport clone, so no field-by-field payload projection sits here.
				return settings;
			},
			{
				params: conversationIdParams,
				response: conversationGenerationSettingsResponse,
			},
		)
		.post(
			"/api/conversations/:id/generations",
			async ({ params, body }) => acceptanceResponse(
				params.id,
				() => generationCoordinator.startGeneration({
					conversationId: params.id,
					expectedRevision: body.previewId === undefined ? body.expectedRevision : undefined,
					target: { kind: body.kind, content: body.content, moves: body.moves },
					formatting: { timeZone: body.timeZone, locale: body.locale },
					preview: previewUseFor(database, params.id, body.previewId, body.promptPlan),
				}),
				generationStartResponse,
			),
			{
				params: conversationIdParams,
				body: generationBody,
				response: generationStartResponse,
			},
		)
		.get(
			"/api/conversations/:id/generations/:generationId/events",
			(context) => {
				const { params, query } = context;
				const runtime = generationRuntimeFor(database).get(params.generationId);
				if (runtime === undefined || runtime.state.conversationId !== params.id) {
					return notFoundResponse();
				}
				return generationSubscriptionEvents(runtime, query.after ?? 0, context);
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
						target: { kind: body.kind, messageId: params.messageId, reroll: body.reroll },
						formatting: { timeZone: body.timeZone, locale: body.locale },
						preview: body.previewId === undefined
							? undefined
							: previewUseFor(database, params.id, body.previewId, body.promptPlan),
					}),
					siblingGenerationResponse,
				),
				{
					params: messageIdParams,
					body: siblingGenerationBody,
					response: siblingGenerationResponse,
				},
		)
		// @approved
		//  Revisioned Conversation commands remain separate from the
		// server-owned Generation acceptance and event routes above.
		.post(
			"/api/conversations/:id/commands",
			async ({ params, body }) => {
				try {
					// @approved
					//  SAFETY: Elysia validates the discriminated command shape at this
					// boundary; the Conversation domain then validates generation values
					// before persistence and keeps the action vocabulary closed.
					const action = body.action as ConversationAction;
					// @approved
					// An upgrade checks the Chat against a version that may not be loaded yet.
					const candidate = action.type === "upgrade-box" ? await loadBoxVersion(action.box, action.version).catch(() => undefined) : undefined;
					const target = action.type === "upgrade-box" ? candidate
						: action.type === "set-box-setup" || (action.type === "commit-box" && action.setup !== undefined) ? chatBox(drizzle(database), params.id, action.box) : undefined;
					const boxes = target?.box.setupError === undefined ? [] : [target];
					const conversation = await withBoxOperations(boxes, () => executeConversationCommand(database, {
							conversationId: params.id,
							expectedRevision: body.expectedRevision,
							action,
						}));
					return {
						outcome: "applied" as const,
						conversation: toConversationSummary(conversation),
					};
				} catch (error) {
					return presentDomainError(error, conversationCommandResponse);
				}
			},
			{
				params: conversationIdParams,
				body: conversationCommandBody,
				response: conversationCommandResponse,
			},
		)
		.post(
			"/api/conversations/:id/fork",
			({ params, body }) => {
				try {
					const result = forkConversation(database, { conversationId: params.id, ...body });
					return { outcome: "applied" as const, ...result, conversation: toConversationSummary(result.conversation) };
				} catch (error) {
					return presentDomainError(error, conversationForkResponse);
				}
			},
			{ params: conversationIdParams, body: forkConversationBody, response: conversationForkResponse },
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
					return presentDomainError(error, addCharacterToCastResponse);
				}
			},
			{
				params: conversationIdParams,
				body: addCharacterToCastBody,
				response: addCharacterToCastResponse,
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
					return presentDomainError(error, saveParticipantAsCharacterResponse);
				}
			},
			{
				params: participantIdParams,
				body: saveParticipantAsCharacterBody,
				response: saveParticipantAsCharacterResponse,
			},
		);
};
