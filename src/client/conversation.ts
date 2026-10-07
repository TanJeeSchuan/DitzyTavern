import { api } from "./lib/eden";
import { requestOutcome } from "./lib/request-outcome";
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
import { decodeWirePayload } from "./lib/wire-decode";
import { NetworkError } from "./lib/network-error";

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
	const { data, error, response } = await api.api.conversations({ id: conversationId }).get({ fetch: { signal } });
	if (error !== null && error !== undefined) {
		if (response === undefined) throw new NetworkError(`Unable to load Conversation ${conversationId}`);
		if (error.status === 404) return null;
		throw new Error(`Unable to load Conversation ${conversationId}`);
	}
	if (data === null) return null;
	const conversation = decodeWirePayload(conversationSummary, data);
	if (conversation === null) throw new Error(`Unable to load Conversation ${conversationId}`);
	return conversation;
}

// The Conversation command route's outcome is the wire's own: the applied
// ==[HUMAN APPROVED]== response under `available`, the typed 409/404/422 envelopes verbatim,
// and network for everything the seam could not classify.
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
	const { data, error } = await api.api.conversations({ id: conversationId })["generation-settings"].get({ fetch: { signal } });
	if (error || data === undefined) throw new Error("Unable to load Conversation Generation Settings.");
	const settings = decodeWirePayload(conversationGenerationSettings, data);
	if (settings === null) throw new Error("Unable to load Conversation Generation Settings.");
	return settings;
}

export async function loadConversationPromptPreset(
	conversationId: number,
	signal?: AbortSignal,
): Promise<ConversationPromptPreset | null> {
	const { data, error } = await api.api
		.conversations({ id: conversationId })["prompt-preset"].get({ fetch: { signal } });
	if (error !== null && error !== undefined) {
		if (error.status === 404) return null;
		throw new Error("Unable to load the selected Prompt Preset.");
	}
	if (data === null) return null;
	const preset = decodeWirePayload(conversationPromptPreset, data);
	if (preset === null) throw new Error("Unable to load the selected Prompt Preset.");
	return preset;
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
) {
	return requestOutcome(
		api.api.conversations({ id: conversationId }).generations.preview.post(input),
		generationPreview,
		generationPreviewErrors,
	);
}

// Starts a server-owned generation without coupling acceptance to a browser
// ==[HUMAN APPROVED]== stream. Call subscribeConversationGeneration separately for each observing
// client, including clients that reconnect after a reload.
export async function startConversationGeneration(
	conversationId: number,
	expectedRevision: number,
	content: string,
	formatting?: GenerationFormattingContext,
	preview?: { previewId: string; promptPlan: PromptPlan },
) {
	return requestOutcome(
		api.api.conversations({ id: conversationId }).generations.post({ expectedRevision, content, ...formatting, ...preview }),
		generationAccepted,
		generationStartErrors,
	);
}

export async function startConversationSiblingGeneration(
	conversationId: number,
	messageId: number,
	formatting?: GenerationFormattingContext,
	preview?: { previewId: string; promptPlan: PromptPlan },
) {
	return requestOutcome(
		api.api.conversations({ id: conversationId }).messages({ messageId }).sibling.generations.post({
			...formatting,
			...preview,
		}),
		generationAccepted,
		generationPreviewErrors,
	);
}

export async function startConversationContinuationGeneration(
	conversationId: number,
	expectedRevision: number,
	formatting?: GenerationFormattingContext,
	preview?: { previewId: string; promptPlan: PromptPlan },
) {
	return requestOutcome(
		api.api.conversations({ id: conversationId }).continue.generations.post({ expectedRevision, ...formatting, ...preview }),
		generationAccepted,
		generationStartErrors,
	);
}

// Stop is an explicit server command. The caller may separately abort its
// ==[HUMAN APPROVED]== local subscription after this request; closing that subscription alone never
// reaches this function and therefore cannot cancel provider work.
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
