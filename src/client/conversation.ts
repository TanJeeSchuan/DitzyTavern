import { api } from "./lib/eden";
import type { Static } from "@sinclair/typebox";
import type { CharacterSnapshot } from "./character-library";
import { commandOutcome } from "./lib/command-outcome";
import type { EdenResponse } from "./lib/eden";
import type {
	ActiveGenerationDetails,
	ConversationAction,
	ConversationGenerationSettings,
	ConversationSummary,
	GenerationAccepted,
	GenerationStartResponse,
	GenerationStopped,
	GenerationsStopped,
	VariantDetails,
} from "../shared/contract/conversation-schema";
import { notFoundOutcome } from "../shared/contract/outcomes";
import type { ConversationPromptPreset } from "../shared/contract/prompt-preset";

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
} from "../shared/contract/conversation-schema";
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
	return data ?? null;
}

export async function applyConversationCommand(
	conversationId: number,
	expectedRevision: number,
	action: ConversationAction,
): Promise<CommandOutcome> {
	const { data, error } = await api.api.conversations({ id: conversationId }).commands.post({
		expectedRevision,
		action,
	});
	if (error) {
		return commandOutcome(error.value, {
			conflict: (payload) => ({ status: "conflict", currentConversation: payload.currentConversation }),
			"not-playable": (payload) => ({ status: "not-playable", reason: payload.reason }),
			"not-removable": (payload) => ({ status: "not-removable", reason: payload.reason }),
			invalid: (payload) => ({ status: "invalid", reason: payload.reason }),
		});
	}
	return { status: "applied", conversation: data.conversation };
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
	return { status: "applied", conversation: data.conversation };
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
	return { status: "applied", character: data.character };
}

export async function loadConversationGenerationSettings(
	conversationId: number,
): Promise<ConversationGenerationSettings> {
	const { data, error } = await api.api.conversations({ id: conversationId })["generation-settings"].get();
	if (error) throw new Error("Unable to load Conversation Generation Settings.");
	return data;
}

export async function loadConversationPromptPreset(
	conversationId: number,
): Promise<ConversationPromptPreset | null> {
	const { data, error } = await api.api
		.conversations({ id: conversationId })["prompt-preset"].get();
	if (error !== null && error !== undefined) {
		if (error.status === 404) return null;
		throw new Error("Unable to load the selected Prompt Preset.");
	}
	return data ?? null;
}

export type GenerationDetailsOutcome<T> =
	| { status: "available"; details: T }
	| { status: "not-found" }
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
		if (error) return error.status === 404 ? { status: "not-found" } : { status: "network" };
		return { status: "available", details: data };
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
		if (error) return error.status === 404 ? { status: "not-found" } : { status: "network" };
		return { status: "available", details: data };
	} catch {
		return { status: "network" };
	}
}

export type StartConversationGenerationResult = GenerationStartResponse;

export interface MacroFormattingContext {
	timeZone?: string;
	locale?: string;
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
		return data;
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
	formatting?: MacroFormattingContext,
): Promise<StartConversationGenerationResult> {
	return postGenerationStart(
		api.api.conversations({ id: conversationId }).generations.post({ expectedRevision, content, ...formatting }),
		"",
	);
}

export function startConversationSiblingGeneration(
	conversationId: number,
	messageId: number,
	formatting?: MacroFormattingContext,
): Promise<StartConversationGenerationResult> {
	return postGenerationStart(
		api.api.conversations({ id: conversationId }).messages({ messageId }).sibling.generations.post({ query: formatting }),
		"Sibling",
	);
}

export function startConversationContinuationGeneration(
	conversationId: number,
	expectedRevision: number,
	formatting?: MacroFormattingContext,
): Promise<StartConversationGenerationResult> {
	return postGenerationStart(
		api.api.conversations({ id: conversationId }).continue.generations.post({ expectedRevision, ...formatting }),
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
