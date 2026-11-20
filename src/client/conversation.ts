import { api } from "./lib/eden";
import type {
	ConversationAction,
	ConversationGenerationSettings,
	ConversationSummary,
	ForkConversationBody,
	GenerationPreviewBody,
	GenerationBody,
} from "../shared/contract/conversation-schema";
import {
	addCharacterToCastResponse,
	conversationCommandResponse,
	conversationForkResponse,
	conversationGenerationSettingsResponse,
	conversationReadResponse,
	generationInspectionResponse,
	generationPreviewResponse,
	generationStartResponse,
	generationStopResponse,
	generationsStopResponse,
	saveParticipantAsCharacterResponse,
	variantDetailsResponse,
} from "../shared/contract/conversation-schema";
import { macroVariablesEditResponse, macroVariablesReadResponse, type MacroValue } from "../shared/contract/macro-variables";
import { conversationPromptPresetResponse, type ConversationPromptPreset } from "../shared/contract/prompt-preset";
import { foundOrNull, requestData } from "./lib/request-outcome";
import { requestOutcome } from "./lib/request-route-outcome";

export type {
	ActiveGenerationDetails,
	CastParticipant,
	ConversationAction,
	ConversationControl,
	ConversationGenerationSettings,
	ConversationSummary,
	ContinuationPrefillSuffix,
	GenerationInspectionStatus,
	GenerationProvenance,
	GenerationRequestOverrides,
	VariantDetails,
} from "../shared/contract/conversation-schema";
export type { MacroVariable, MacroVariables } from "../shared/contract/macro-variables";
export type { GenerationPreview, GenerationPreviewBody } from "../shared/contract/conversation-schema";

export async function loadConversation(
	conversationId: number,
	signal?: AbortSignal,
): Promise<ConversationSummary | null> {
	return foundOrNull(await requestOutcome(
		api.api.conversations({ id: conversationId }).get({ fetch: { signal } }),
		conversationReadResponse,
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
		conversationCommandResponse,
	);
}

export async function forkConversation(conversationId: number, body: ForkConversationBody) {
	return requestOutcome(api.api.conversations({ id: conversationId }).fork.post(body), conversationForkResponse);
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
		addCharacterToCastResponse,
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
		saveParticipantAsCharacterResponse,
	);
}

export async function loadConversationGenerationSettings(
	conversationId: number,
	signal?: AbortSignal,
): Promise<ConversationGenerationSettings> {
	return requestData(
		api.api.conversations({ id: conversationId })["generation-settings"].get({ fetch: { signal } }),
		conversationGenerationSettingsResponse[200],
	);
}

export async function loadConversationPromptPreset(
	conversationId: number,
	signal?: AbortSignal,
	presetId?: number,
): Promise<ConversationPromptPreset | null> {
	return foundOrNull(await requestOutcome(
		api.api.conversations({ id: conversationId })["prompt-preset"].get({ query: { presetId }, fetch: { signal } }),
		conversationPromptPresetResponse,
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
		macroVariablesReadResponse,
	);
}

export type MacroVariableEditResult = Awaited<ReturnType<typeof editMacroVariable>>;

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
		macroVariablesEditResponse,
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
		generationInspectionResponse,
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
		variantDetailsResponse,
	);
}

export async function previewConversationGeneration(
	conversationId: number,
	input: GenerationPreviewBody,
	signal?: AbortSignal,
) {
	return requestOutcome(
		api.api.conversations({ id: conversationId }).generations.preview.post(input, { fetch: { signal } }),
		generationPreviewResponse,
	);
}

// @approved
// Starts a server-owned generation without coupling acceptance to a browser
//  stream. Call subscribeConversationGeneration separately for each observing
// client, including clients that reconnect after a reload.

export async function startConversationGeneration(conversationId: number, input: GenerationBody, signal?: AbortSignal) {
	return requestOutcome(
		api.api.conversations({ id: conversationId }).generations.post(input, { fetch: { signal } }),
		generationStartResponse,
	);
}

// @approved
// Stop is an explicit server command. The caller may separately abort its
//  local subscription after this request; closing that subscription alone never
// reaches this function and therefore cannot cancel provider work.
export type GenerationStopResult = Awaited<ReturnType<typeof stopConversationGeneration | typeof stopAllConversationGenerations>>;

export async function stopConversationGeneration(conversationId: number, generationId: number) {
	return requestOutcome(
		api.api.conversations({ id: conversationId }).generations({ generationId }).stop.post({}),
		generationStopResponse,
	);
}

export async function stopAllConversationGenerations(conversationId: number) {
	return requestOutcome(
		api.api.conversations({ id: conversationId }).generations["stop-all"].post({}),
		generationsStopResponse,
	);
}
