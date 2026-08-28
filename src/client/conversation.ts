import { api } from "./lib/eden";
import type { CharacterSnapshot } from "./character-library";
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

export type {
	ActiveGenerationDetails,
	CastParticipant,
	ConversationAction,
	ConversationControl,
	ConversationControlValidity,
	ConversationGenerationSettings,
	ConversationSummary,
	ContinuationPrefillSuffix,
	GenerationDetailsJsonObject,
	GenerationDetailsJsonValue,
	GenerationInspectionStatus,
	GenerationProvenance,
	GenerationRequestOverrides,
	GenerationRequestValue,
	ParticipantDefinition,
	ParticipantPrompt,
	VariantDetails,
} from "../shared/contract/conversation-schema";
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
		const payload = error.value;
		if (payload.outcome === "conflict") {
			return { status: "conflict", currentConversation: payload.currentConversation };
		}
		if (payload.outcome === "not-found") return { status: "not-found" };
		if (payload.outcome === "not-playable") return { status: "not-playable", reason: payload.reason };
		if (payload.outcome === "not-removable") return { status: "not-removable", reason: payload.reason };
		if (payload.outcome === "invalid") return { status: "invalid", reason: payload.reason };
		return { status: "network" };
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
		const payload = error.value;
		if (payload.outcome === "conflict") {
			if ("currentConversation" in payload) {
				return { status: "conflict", currentConversation: payload.currentConversation };
			}
			return { status: "conflict", currentCharacterName: payload.currentCharacter.name };
		}
		if (payload.outcome === "not-found") return { status: "not-found" };
		if (payload.outcome === "invalid") return { status: "invalid", reason: payload.reason };
		return { status: "network" };
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
		const payload = error.value;
		if (payload.outcome === "conflict") {
			return { status: "conflict", currentConversation: payload.currentConversation };
		}
		if (payload.outcome === "not-found") return { status: "not-found" };
		if (payload.outcome === "invalid") return { status: "invalid", reason: payload.reason };
		return { status: "network" };
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

export const loadActiveGenerationInspection = loadActiveGenerationDetails;

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

export const loadGenerationVariantDetails = loadVariantDetails;

export type StartConversationGenerationResult = GenerationStartResponse;

const startGenerationError = (
	payload: Exclude<GenerationStartResponse, { outcome: "accepted" }>,
	label: string,
): StartConversationGenerationResult => {
	const operation = label === "" ? "Generation" : `${label} Generation`;
	if (payload.outcome === "not-found") return { outcome: "not-found" };
	if (payload.outcome === "conflict") {
		return {
			outcome: "conflict",
			reason: payload.reason || "Generation start conflicted with a newer Conversation revision.",
		};
	}
	if (payload.outcome === "not-playable") {
		return { outcome: "not-playable", reason: payload.reason || "The Conversation is not playable." };
	}
	return { outcome: "invalid", reason: payload.reason || `${operation} could not be started.` };
};

type GenerationStartError = Exclude<GenerationStartResponse, { outcome: "accepted" }>;
type GenerationStartRequest = Promise<{
	data: GenerationAccepted;
	error: { value: GenerationStartError } | null;
}>;

const postGenerationStart = async (
	request: GenerationStartRequest,
	label: string,
): Promise<StartConversationGenerationResult> => {
	const operation = label === "" ? "Generation" : `${label} Generation`;
	try {
		const { data, error } = await request;
		if (error) {
			return startGenerationError(error.value, label);
		}
		return data;
	} catch {
		return { outcome: "invalid", reason: `${operation} start returned malformed JSON.` };
	}
};

// Starts a server-owned generation without coupling acceptance to a browser
// stream. Call subscribeConversationGeneration separately for each observing
// client, including clients that reconnect after a reload.
export function startConversationGeneration(
	conversationId: number,
	expectedRevision: number,
	content: string,
): Promise<StartConversationGenerationResult> {
	return postGenerationStart(
		api.api.conversations({ id: conversationId }).generations.post({ expectedRevision, content }),
		"",
	);
}

export function startConversationSiblingGeneration(
	conversationId: number,
	messageId: number,
): Promise<StartConversationGenerationResult> {
	return postGenerationStart(
		api.api.conversations({ id: conversationId }).messages({ messageId }).sibling.generations.post({}),
		"Sibling",
	);
}

export function startConversationContinuationGeneration(
	conversationId: number,
	expectedRevision: number,
): Promise<StartConversationGenerationResult> {
	return postGenerationStart(
		api.api.conversations({ id: conversationId }).continue.generations.post({ expectedRevision }),
		"Continuation",
	);
}

export type StopConversationGenerationResult =
	| { outcome: "stopped"; generationId?: number; conversation?: ConversationSummary }
	| { outcome: "not-found" }
	| { outcome: "failed"; reason: string };

type StopGenerationError = {
	value: { outcome: "not-found" } | { outcome: string; reason: string };
	status?: number;
};
type StopGenerationResponse = GenerationStopped | GenerationsStopped;
type StopGenerationRequest = Promise<{
	data: StopGenerationResponse;
	error: StopGenerationError | null;
}>;

const postGenerationStop = async (
	request: StopGenerationRequest,
	all: boolean,
): Promise<StopConversationGenerationResult & { generationIds?: number[] }> => {
	try {
		const { data, error } = await request;
		if (error) {
			if (error.status === 503) {
				return { outcome: "failed", reason: all ? "Generations could not be stopped." : "Generation could not be stopped." };
			}
			return error.value.outcome === "not-found"
				? { outcome: "not-found" }
				: { outcome: "failed", reason: "reason" in error.value ? error.value.reason : "Generation could not be stopped." };
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
// local subscription after this request; closing that subscription alone never
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
