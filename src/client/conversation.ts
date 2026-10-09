import type { StaticDecode } from "@sinclair/typebox";
import { api } from "./lib/eden";
import type {
	ConversationAction,
	ConversationGenerationSettings,
	ConversationSummary,
	GenerationPreviewBody,
	GenerationFormattingContext,
	PromptPlan,
} from "../shared/contract/conversation-schema";
import {
	activeGenerationDetails,
	castCharacterErrors,
	characterAppliedResponse,
	conversationAppliedResponse,
	conversationCommandErrors,
	conversationConflictErrors,
	conversationGenerationSettings,
	conversationSummary,
	generationAccepted,
	generationPreview,
	generationPreviewErrors,
	generationStartErrors,
	generationStopped,
	generationsStopped,
	variantDetails,
} from "../shared/contract/conversation-schema";
import { macroVariables, macroVariablesAppliedResponse } from "../shared/contract/macro-variables";
import type { MacroValue } from "../shared/contract/macro-variables";
import { notFoundOutcome, readOutcomeErrors } from "../shared/contract/outcomes";
import type { ConversationPromptPreset } from "../shared/contract/prompt-preset";
import { conversationPromptPreset } from "../shared/contract/prompt-preset";
import { foundOrNull, requestData, requestOutcome, type RequestOutcome } from "./lib/request-outcome";

export type {
	ActiveGenerationDetails,
	CastParticipant,
	ConversationAction,
	ConversationControl,
	ConversationControlValidity,
	ConversationGenerationSettings,
	ConversationSummary,
	ContinuationPrefillSuffix,
	GenerationInspectionStatus,
	GenerationProvenance,
	GenerationRequestOverrides,
	ParticipantDefinition,
	VariantDetails,
	LoreActivationRecord,
} from "../shared/contract/conversation-schema";
export type { MacroVariable, MacroVariables, MacroVariablesEditBody } from "../shared/contract/macro-variables";
export type { GenerationPreview, GenerationPreviewBody } from "../shared/contract/conversation-schema";
export type { PromptChannels } from "../shared/contract/prompt-schema";
export type {
	GenerationStreamDelta,
	GenerationStreamResult,
	GenerationStreamState,
} from "./conversation-stream";
export { subscribeConversationGeneration } from "./conversation-stream";

export async function loadConversation(
	conversationId: number,
	signal?: AbortSignal,
): Promise<ConversationSummary | null> {
	return foundOrNull(await requestOutcome(
		api.api.conversations({ id: conversationId }).get({ fetch: { signal } }),
		conversationSummary,
		notFoundOutcome,
	));
}

// @approved
// The Conversation command route's outcome is the wire's own: the applied
//  response under `available`, the typed 409/404/422 envelopes verbatim,
// network when the transport could not complete the request, and the shared
// unusable fallback when the response could not be read.
export type CommandOutcome = Awaited<ReturnType<typeof applyConversationCommand>>;

export async function applyConversationCommand(
	conversationId: number,
	expectedRevision: number,
	action: ConversationAction,
) {
	return requestOutcome(
		api.api.conversations({ id: conversationId }).commands.post({
			expectedRevision,
			action,
		}),
		conversationAppliedResponse,
		conversationCommandErrors,
	);
}

export async function addCharacterToCast(input: {
	conversationId: number;
	expectedConversationRevision: number;
	characterId: number;
	expectedCharacterRevision: number;
}) {
	return requestOutcome(
		api.api
			.conversations({ id: input.conversationId })
			.cast.characters.post({
				expectedConversationRevision: input.expectedConversationRevision,
				characterId: input.characterId,
				expectedCharacterRevision: input.expectedCharacterRevision,
			}),
		conversationAppliedResponse,
		castCharacterErrors,
	);
}

export async function saveParticipantAsCharacter(input: {
	conversationId: number;
	expectedConversationRevision: number;
	participantId: number;
}) {
	return requestOutcome(
		api.api
			.conversations({ id: input.conversationId })
			.cast.participants({ participantId: input.participantId })
			.characters.post({ expectedConversationRevision: input.expectedConversationRevision }),
		characterAppliedResponse,
		conversationConflictErrors,
	);
}

export async function loadConversationGenerationSettings(
	conversationId: number,
	signal?: AbortSignal,
): Promise<ConversationGenerationSettings> {
	return requestData(
		api.api.conversations({ id: conversationId })["generation-settings"].get({ fetch: { signal } }),
		conversationGenerationSettings,
	);
}

export async function loadConversationPromptPreset(
	conversationId: number,
	signal?: AbortSignal,
): Promise<ConversationPromptPreset | null> {
	return foundOrNull(await requestOutcome(
		api.api.conversations({ id: conversationId })["prompt-preset"].get({ fetch: { signal } }),
		conversationPromptPreset,
		notFoundOutcome,
	));
}

export async function loadMacroVariables(
	conversationId: number,
	input: { position?: number; promptPresetId?: number } = {},
) {
	return requestOutcome(
		api.api
			.conversations({ id: conversationId })["macro-variables"]
			.get({ query: input }),
		macroVariables,
		readOutcomeErrors,
	);
}

export type MacroVariableEditResult = RequestOutcome<StaticDecode<typeof macroVariablesAppliedResponse>, StaticDecode<typeof conversationConflictErrors>>;

export async function editMacroVariable(
	conversationId: number,
	input: {
		expectedRevision: number;
		promptPresetId: number;
		position: number;
	} & ({ operation: "set"; name: string; value: MacroValue } | { operation: "delete"; name: string }),
) {
	return requestOutcome(
		api.api
			.conversations({ id: conversationId })["macro-variables"]
			.post(input),
		macroVariablesAppliedResponse,
		conversationConflictErrors,
	);
}

export async function loadActiveGenerationDetails(
	conversationId: number,
	generationId: number,
) {
	return requestOutcome(
		api.api
			.conversations({ id: conversationId })
			.generations({ generationId })
			.inspection.get(),
		activeGenerationDetails,
		readOutcomeErrors,
	);
}

export async function loadVariantDetails(
	conversationId: number,
	messageId: number,
	variantId: number,
) {
	return requestOutcome(
		api.api
			.conversations({ id: conversationId })
			.messages({ messageId })
			.variants({ variantId })
			.details.get(),
		variantDetails,
		readOutcomeErrors,
	);
}

export async function previewConversationGeneration(
	conversationId: number,
	input: GenerationPreviewBody,
	signal?: AbortSignal,
) {
	return requestOutcome(
		api.api.conversations({ id: conversationId }).generations.preview.post(input, { fetch: { signal } }),
		generationPreview,
		generationPreviewErrors,
	);
}

// @approved
// Starts a server-owned generation without coupling acceptance to a browser
//  stream. Call subscribeConversationGeneration separately for each observing
// client, including clients that reconnect after a reload.
export type GenerationStartResult = RequestOutcome<StaticDecode<typeof generationAccepted>, StaticDecode<typeof generationStartErrors>>;

export async function startConversationGeneration(
	conversationId: number,
	expectedRevision: number,
	content: string,
	formatting?: GenerationFormattingContext,
	preview?: { previewId: string; promptPlan: PromptPlan },
	signal?: AbortSignal,
) {
	return requestOutcome(
		api.api.conversations({ id: conversationId }).generations.post({ kind: "send", expectedRevision, content, ...formatting, ...preview }, { fetch: { signal } }),
		generationAccepted,
		generationStartErrors,
	);
}

export async function startConversationSiblingGeneration(
	conversationId: number,
	messageId: number,
	formatting?: GenerationFormattingContext,
	preview?: { previewId: string; promptPlan: PromptPlan },
	signal?: AbortSignal,
) {
	return requestOutcome(
		api.api.conversations({ id: conversationId }).messages({ messageId }).sibling.generations.post({
			kind: "sibling",
			...formatting,
			...preview,
		}, { fetch: { signal } }),
		generationAccepted,
		generationPreviewErrors,
	);
}

export async function startConversationContinuationGeneration(
	conversationId: number,
	expectedRevision: number,
	formatting?: GenerationFormattingContext,
	preview?: { previewId: string; promptPlan: PromptPlan },
	signal?: AbortSignal,
) {
	return requestOutcome(
		api.api.conversations({ id: conversationId }).continue.generations.post({ kind: "continuation", expectedRevision, ...formatting, ...preview }, { fetch: { signal } }),
		generationAccepted,
		generationStartErrors,
	);
}

// @approved
// Stop is an explicit server command. The caller may separately abort its
//  local subscription after this request; closing that subscription alone never
// reaches this function and therefore cannot cancel provider work.
export type GenerationStopResult =
	RequestOutcome<StaticDecode<typeof generationStopped> | StaticDecode<typeof generationsStopped>, StaticDecode<typeof notFoundOutcome>>;

export async function stopConversationGeneration(conversationId: number, generationId: number) {
	return requestOutcome(
		api.api.conversations({ id: conversationId }).generations({ generationId }).stop.post({}),
		generationStopped,
		notFoundOutcome,
	);
}

export async function stopAllConversationGenerations(conversationId: number) {
	return requestOutcome(
		api.api.conversations({ id: conversationId }).generations["stop-all"].post({}),
		generationsStopped,
		notFoundOutcome,
	);
}
