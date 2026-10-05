import { api } from "./lib/eden";
import type { Static } from "@sinclair/typebox";
import type { CharacterSnapshot } from "./character-library";
import { commandOutcome } from "./lib/command-outcome";
import { waitForImageLoads, withInlineImages } from "./lib/image";
import type { EdenResponse } from "./lib/eden";
import type {
	ActiveGenerationDetails,
	ConversationAction,
	ConversationGenerationSettings,
	ConversationSummary,
	GenerationAccepted,
	GenerationStartResponse,
	GenerationPreview,
	GenerationPreviewBody,
	GenerationFormattingContext,
	PromptPlan,
	GenerationStopped,
	GenerationsStopped,
	VariantDetails,
} from "../shared/contract/conversation-schema";
import {
	activeGenerationDetails,
	conversationSummary,
	generationPreview,
	generationStartResponse,
	variantDetails,
	conversationGenerationSettings,
	conversationAppliedResponse,
	characterAppliedResponse,
} from "../shared/contract/conversation-schema";
import { notFoundOutcome } from "../shared/contract/outcomes";
import type { ConversationPromptPreset } from "../shared/contract/prompt-preset";
import { conversationPromptPreset } from "../shared/contract/prompt-preset";
import {
	macroVariables,
	macroVariablesAppliedResponse,
} from "../shared/contract/macro-variables";
import type { MacroVariables } from "../shared/contract/macro-variables";
import type { MacroValue } from "../shared/contract/macro-variables";
import { decodeWirePayload } from "./lib/wire-decode";

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

export type CommandOutcome =
	| { status: "applied"; conversation: ConversationSummary }
	| { status: "conflict"; currentConversation: ConversationSummary }
	| { status: "not-found" }
	| { status: "not-playable"; reason: string }
	| { status: "not-removable"; reason: string }
	| { status: "invalid"; reason: string }
	| { status: "network" };

export type AddCharacterOutcome =
	| { status: "applied"; conversation: ConversationSummary }
	| {
			status: "conflict";
			currentConversation?: ConversationSummary;
			currentCharacterName?: string;
	  }
	| { status: "not-found" }
	| { status: "invalid"; reason: string }
	| { status: "network" };

export async function loadConversation(
	conversationId: number,
): Promise<ConversationSummary | null> {
	const { data, error } = await api.api.conversations({ id: conversationId }).get();
	if (error !== null && error !== undefined) {
		if (error.status === 404) return null;
		throw new Error(`Unable to load Conversation ${conversationId}`);
	}
	if (data === null) return null;
	const conversation = decodeWirePayload(conversationSummary, data);
	if (conversation === null) throw new Error(`Unable to load Conversation ${conversationId}`);
	return conversation;
}

export async function applyConversationCommand(
	conversationId: number,
	expectedRevision: number,
	action: ConversationAction,
): Promise<CommandOutcome> {
	const { data, error } = await withInlineImages(JSON.stringify(action), (images) =>
		api.api.conversations({ id: conversationId }).commands.post({ expectedRevision, action, images }),
	);
	if (error) {
		return commandOutcome(error.value, {
			conflict: (payload) => ({ status: "conflict", currentConversation: payload.currentConversation }),
			"not-playable": (payload) => ({ status: "not-playable", reason: payload.reason }),
			"not-removable": (payload) => ({ status: "not-removable", reason: payload.reason }),
			invalid: (payload) => ({ status: "invalid", reason: payload.reason }),
		});
	}
	const response = decodeWirePayload(conversationAppliedResponse, data);
	return response === null
		? { status: "network" }
		: { status: "applied", conversation: response.conversation };
}

export async function addCharacterToCast(input: {
	conversationId: number;
	expectedConversationRevision: number;
	characterId: number;
	expectedCharacterRevision: number;
}): Promise<AddCharacterOutcome> {
	const { data, error } = await api.api
		.conversations({ id: input.conversationId })
		.cast.characters.post({
			expectedConversationRevision: input.expectedConversationRevision,
			characterId: input.characterId,
			expectedCharacterRevision: input.expectedCharacterRevision,
		});
	if (error) {
		return commandOutcome(error.value, {
			conflict: (payload) => {
				if ("currentConversation" in payload) {
					return { status: "conflict", currentConversation: payload.currentConversation };
				}
				return { status: "conflict", currentCharacterName: payload.currentCharacter.name };
			},
			invalid: (payload) => ({ status: "invalid", reason: payload.reason }),
		});
	}
	const response = decodeWirePayload(conversationAppliedResponse, data);
	return response === null
		? { status: "network" }
		: { status: "applied", conversation: response.conversation };
}

export type SaveParticipantAsCharacterOutcome =
	| { status: "applied"; character: CharacterSnapshot }
	| { status: "conflict"; currentConversation: ConversationSummary }
	| { status: "not-found" }
	| { status: "invalid"; reason: string }
	| { status: "network" };

export async function saveParticipantAsCharacter(input: {
	conversationId: number;
	expectedConversationRevision: number;
	participantId: number;
}): Promise<SaveParticipantAsCharacterOutcome> {
	const { data, error } = await api.api
		.conversations({ id: input.conversationId })
		.cast.participants({ participantId: input.participantId })
		.characters.post({ expectedConversationRevision: input.expectedConversationRevision });
	if (error) {
		return commandOutcome(error.value, {
			conflict: (payload) => ({ status: "conflict", currentConversation: payload.currentConversation }),
			invalid: (payload) => ({ status: "invalid", reason: payload.reason }),
		});
	}
	const response = decodeWirePayload(
		characterAppliedResponse,
		data,
	);
	return response === null
		? { status: "network" }
		: { status: "applied", character: response.character };
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

export type MacroVariablesOutcome =
	| { status: "available"; variables: MacroVariables }
	| { status: "not-found" }
	| { status: "invalid"; reason: string }
	| { status: "network" };

export async function loadMacroVariables(
	conversationId: number,
	input: { position?: number; promptPresetId?: number } = {},
): Promise<MacroVariablesOutcome> {
	try {
		const { data, error } = await api.api
			.conversations({ id: conversationId })["macro-variables"]
			.get({ query: input });
		if (error) {
			if (error.status === 404) return { status: "not-found" };
			if (error.status === 422) return { status: "invalid", reason: error.value.reason };
			return { status: "network" };
		}
		const variables = decodeWirePayload(macroVariables, data);
		return variables === null
			? { status: "network" }
			: { status: "available", variables };
	} catch {
		return { status: "network" };
	}
}

export type EditMacroVariablesOutcome =
	| { status: "applied"; variables: MacroVariables; conversation: ConversationSummary }
	| { status: "conflict"; currentConversation: ConversationSummary }
	| { status: "not-found" }
	| { status: "invalid"; reason: string }
	| { status: "network" };

export async function editMacroVariable(
	conversationId: number,
	input: {
		expectedRevision: number;
		promptPresetId: number;
		position: number;
	} & ({ operation: "set"; name: string; value: MacroValue } | { operation: "delete"; name: string }),
	previousValue: MacroValue | undefined,
): Promise<EditMacroVariablesOutcome> {
	try {
		await waitForImageLoads(JSON.stringify(previousValue ?? null));
		const { data, error } = await withInlineImages(JSON.stringify(input), (images) =>
			api.api.conversations({ id: conversationId })["macro-variables"].post({ ...input, images }),
		);
		if (error) {
			if (error.status === 404) return { status: "not-found" };
			if (error.status === 409 && "currentConversation" in error.value) {
				return { status: "conflict", currentConversation: error.value.currentConversation };
			}
			if (error.status === 422) return { status: "invalid", reason: error.value.reason };
			return { status: "network" };
		}
		const payload = decodeWirePayload(macroVariablesAppliedResponse, data);
		if (payload === null) return { status: "network" };
		return {
			status: "applied",
			variables: payload.variables,
			conversation: payload.conversation,
		};
	} catch {
		return { status: "network" };
	}
}

export type GenerationDetailsOutcome<T> =
	| { status: "available"; details: T }
	| { status: "not-found" }
	| { status: "invalid"; reason: string }
	| { status: "network" };

export async function loadActiveGenerationDetails(
	conversationId: number,
	generationId: number,
): Promise<GenerationDetailsOutcome<ActiveGenerationDetails>> {
	try {
		const { data, error } = await api.api
			.conversations({ id: conversationId })
			.generations({ generationId })
			.inspection.get();
		if (error) {
			if (error.status === 404) return { status: "not-found" };
			if (error.status === 422) return { status: "invalid", reason: error.value.reason };
			return { status: "network" };
		}
		const details = decodeWirePayload(activeGenerationDetails, data);
		return details === null
			? { status: "network" }
			: { status: "available", details };
	} catch {
		return { status: "network" };
	}
}

export async function loadVariantDetails(
	conversationId: number,
	messageId: number,
	variantId: number,
): Promise<GenerationDetailsOutcome<VariantDetails>> {
	try {
		const { data, error } = await api.api
			.conversations({ id: conversationId })
			.messages({ messageId })
			.variants({ variantId })
			.details.get();
		if (error) {
			if (error.status === 404) return { status: "not-found" };
			if (error.status === 422) return { status: "invalid", reason: error.value.reason };
			return { status: "network" };
		}
		const details = decodeWirePayload(variantDetails, data);
		return details === null
			? { status: "network" }
			: { status: "available", details };
	} catch {
		return { status: "network" };
	}
}

export type StartConversationGenerationResult = GenerationStartResponse;

export type GenerationPreviewOutcome =
	| { status: "available"; preview: GenerationPreview }
	| { status: "not-found" }
	| { status: "not-playable"; reason: string }
	| { status: "invalid"; reason: string }
	| { status: "network" };

export async function previewConversationGeneration(
	conversationId: number,
	input: GenerationPreviewBody,
): Promise<GenerationPreviewOutcome> {
	try {
		const { data, error } = await withInlineImages(JSON.stringify(input), (images) =>
			api.api.conversations({ id: conversationId }).generations.preview.post(input.kind === "send" ? { ...input, images } : input),
		);
		if (error) {
			if (error.status === 404) return { status: "not-found" };
			if (error.status === 409) return { status: "not-playable", reason: error.value.reason };
			if (error.status === 422) return { status: "invalid", reason: error.value.reason };
			return { status: "network" };
		}
		const preview = decodeWirePayload(generationPreview, data);
		return preview === null
			? { status: "network" }
			: { status: "available", preview };
	} catch {
		return { status: "network" };
	}
}

const startGenerationError = (
	payload: Exclude<GenerationStartResponse, { outcome: "accepted" }>,
): StartConversationGenerationResult => {
	if (payload.outcome === "not-found") return { outcome: "not-found" };
	if (payload.outcome === "conflict") return { outcome: "conflict", reason: payload.reason };
	if (payload.outcome === "not-playable") return { outcome: "not-playable", reason: payload.reason };
	return { outcome: "invalid", reason: payload.reason };
};

type GenerationStartError = Exclude<GenerationStartResponse, { outcome: "accepted" }>;
type GenerationStartRequest = EdenResponse<
	GenerationAccepted,
	{ status: number; value: GenerationStartError }
>;

const postGenerationStart = async (
	request: GenerationStartRequest,
	label: string,
): Promise<StartConversationGenerationResult> => {
	const operation = label === "" ? "Generation" : `${label} Generation`;
	try {
		const { data, error } = await request;
		if (error) {
			return startGenerationError(error.value);
		}
		const response = decodeWirePayload(generationStartResponse, data);
		if (response === null) {
			return { outcome: "invalid", reason: `${operation} start returned malformed JSON.` };
		}
		return response;
	} catch {
		return { outcome: "invalid", reason: `${operation} start returned malformed JSON.` };
	}
};

// Starts a server-owned generation without coupling acceptance to a browser
// ==[HUMAN APPROVED]== stream. Call subscribeConversationGeneration separately for each observing
// client, including clients that reconnect after a reload.
export function startConversationGeneration(
	conversationId: number,
	expectedRevision: number,
	content: string,
	formatting?: GenerationFormattingContext,
	preview?: { previewId: string; promptPlan: PromptPlan },
): Promise<StartConversationGenerationResult> {
	return postGenerationStart(
		withInlineImages(JSON.stringify({ content, plan: preview?.promptPlan }), (images) =>
			api.api.conversations({ id: conversationId }).generations.post({ expectedRevision, content, images, ...formatting, ...preview }),
		),
		"",
	);
}

export function startConversationSiblingGeneration(
	conversationId: number,
	messageId: number,
	formatting?: GenerationFormattingContext,
	preview?: { previewId: string; promptPlan: PromptPlan },
): Promise<StartConversationGenerationResult> {
	return postGenerationStart(
		withInlineImages(JSON.stringify(preview?.promptPlan ?? null), (images) =>
			api.api.conversations({ id: conversationId }).messages({ messageId }).sibling.generations.post({
				images,
				...formatting,
				...preview,
			}),
		),
		"Sibling",
	);
}

export function startConversationContinuationGeneration(
	conversationId: number,
	expectedRevision: number,
	formatting?: GenerationFormattingContext,
	preview?: { previewId: string; promptPlan: PromptPlan },
): Promise<StartConversationGenerationResult> {
	return postGenerationStart(
		withInlineImages(JSON.stringify(preview?.promptPlan ?? null), (images) =>
			api.api.conversations({ id: conversationId }).continue.generations.post({ expectedRevision, images, ...formatting, ...preview }),
		),
		"Continuation",
	);
}

export type StopConversationGenerationResult =
	| { outcome: "stopped"; generationId?: number; conversation?: ConversationSummary }
	| { outcome: "not-found" }
	| { outcome: "failed"; reason: string };

// ==[HUMAN APPROVED]== The stop routes declare only the shared typed not-found outcome as
// an error response. Any other error status (Elysia's default
// request-validation body, a server 500, a network failure) carries a body
// the client never models: the handler branches only on status and
// substitutes a client-owned reason, so the error shape is not restated.
type StopGenerationError =
	| { status: 404; value: Static<typeof notFoundOutcome> }
	| { status: number; value: unknown };
type StopGenerationResponse = GenerationStopped | GenerationsStopped;
type StopGenerationRequest = EdenResponse<StopGenerationResponse, StopGenerationError>;

const postGenerationStop = async (
	request: StopGenerationRequest,
	all: boolean,
): Promise<StopConversationGenerationResult & { generationIds?: number[] }> => {
	try {
		const { data, error } = await request;
		if (error) {
			return error.status === 404
				? { outcome: "not-found" }
				: {
						outcome: "failed",
						reason: all
							? "Generations could not be stopped."
							: "Generation could not be stopped.",
					};
		}
		const result: StopConversationGenerationResult & { generationIds?: number[] } = { outcome: "stopped" };
		if ("generationId" in data) result.generationId = data.generationId;
		if ("generationIds" in data) result.generationIds = data.generationIds;
		return result;
	} catch {
		return { outcome: "failed", reason: "Stop Generation returned malformed JSON." };
	}
};

// Stop is an explicit server command. The caller may separately abort its
// ==[HUMAN APPROVED]== local subscription after this request; closing that subscription alone never
// reaches this function and therefore cannot cancel provider work.
export function stopConversationGeneration(
	conversationId: number,
	generationId: number,
): Promise<StopConversationGenerationResult> {
	return postGenerationStop(
		api.api.conversations({ id: conversationId }).generations({ generationId }).stop.post({}),
		false,
	);
}

export function stopAllConversationGenerations(
	conversationId: number,
): Promise<StopConversationGenerationResult & { generationIds?: number[] }> {
	return postGenerationStop(
		api.api.conversations({ id: conversationId }).generations["stop-all"].post({}),
		true,
	);
}
