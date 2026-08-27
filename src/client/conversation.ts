import { api } from "./lib/eden";
import type { CharacterSnapshot } from "./character-library";

// Typed client for the deep Conversation transport adapters: snapshot
// reads, revisioned command execution, and the explicit Character-to-Cast
// workflow. Outcomes mirror the server's typed results so the Cast drawer
// and composer can recover from conflicts without losing local drafts.

export interface ParticipantPrompt {
	systemInstruction: string;
	identity: string;
	scenario: string;
	exampleDialogue: string;
	postHistoryInstruction: string;
}

export interface ParticipantDefinition {
	name: string;
	prompt: ParticipantPrompt;
	openings: string[];
}

export interface CastParticipant {
	id: number;
	position: number;
	name: string;
	prompt: ParticipantPrompt;
	openings: string[];
	sourceCharacterId: number | null;
	sourceCharacterName: string | null;
	duplicateLabel: string;
	// Derived removal eligibility and impact: the deletion mode names hard
	// delete versus tombstone, and the affected-generation count states how
	// many Messages lose future sibling Variant generation. Clients present
	// these values; they never reconstruct the rules.
	removal: {
		eligible: boolean;
		reason: "control-assigned" | null;
		deletionMode: "hard-delete" | "tombstone" | null;
		affectedGenerationCount: number;
	};
}

export interface ConversationControl {
	humanParticipantId: number | null;
	modelParticipantId: number | null;
}

export interface ConversationControlValidity {
	valid: boolean;
	reason: "missing-seat" | "seats-not-distinct" | "seat-not-in-cast" | null;
}

export interface ConversationGenerationSettings {
	modelId: string;
	temperature: number | null;
	topP: number | null;
	frequencyPenalty: number | null;
	presencePenalty: number | null;
	contextLimit: number;
	responseBudget: number;
	safetyAllowance: number;
	siblingGenerationLimit: number;
	continuationStrategy: "instruction" | "assistant-prefill";
	continuationInstruction: string;
	continuationPrefillSuffix: ContinuationPrefillSuffix;
	requestOverrides: {
		"chat-completions": GenerationRequestOverrides;
		responses: GenerationRequestOverrides;
		"anthropic-messages": GenerationRequestOverrides;
	};
}

export type ContinuationPrefillSuffix = "" | " " | "\n" | "\n\n";

export type GenerationStreamResult =
	| { outcome: "applied" }
	| { outcome: "stopped"; generationId?: number }
	| { outcome: "not-found" }
	| { outcome: "not-playable" | "failed" | "invalid" | "conflict"; reason: string };

export type GenerationStreamDelta =
	| { type: "content"; text: string }
	| { type: "reasoning"; text: string }
	| { type: "usage"; usage: Record<string, number> }
	| { type: "finished"; finishReason: "stop" | "length" | "other" }
	| { type: "keepalive" };

export interface GenerationStreamState {
	generationId: number;
	conversationId: number;
	messageId: number;
	variantId: number;
	content: string;
	reasoning: string;
	latestEventId: number;
	status: "active" | "complete" | "stopped" | "failed";
	terminalReason: string | null;
}

export type GenerationRequestValue =
	| string
	| number
	| boolean
	| null
	| readonly GenerationRequestValue[]
	| Readonly<{ [key: string]: GenerationRequestValue }>;

export type GenerationRequestOverrides = Readonly<
	Record<string, GenerationRequestValue>
>;

// This summary drives workspace controls, not the transcript. Messages and
// Conversation-scoped data load separately; Import Details loads heavy
// provenance only when requested.
export interface ConversationSummary {
	id: number;
	name: string;
	revision: number;
	cast: CastParticipant[];
	control: ConversationControl;
	controlValidity: ConversationControlValidity;
	playable: boolean;
	capabilities: {
		compose: { available: boolean; reason: "conversation-not-playable" | null };
		generate: { available: boolean; reason: "conversation-not-playable" | null };
		swipe: { available: boolean; reason: "conversation-not-playable" | null };
	};
	activeGeneration?: {
		generationId: number;
		messageId: number;
		variantId: number;
		startedAt: string;
	} | null;
	activeGenerations?: {
		generationId: number;
		messageId: number;
		variantId: number;
		startedAt: string;
	}[];
}

export type ConversationAction =
	| {
			type: "create-message";
			timestamp: string;
			variantContents: string[];
			selectedVariantIndex?: number;
			authorParticipantId: number;
	  }
	| { type: "create-variant"; messageId: number; content: string }
	| { type: "select-variant"; messageId: number; variantId: number }
	| { type: "edit-variant"; messageId: number; variantId: number; content: string }
	| { type: "delete-variant"; messageId: number; variantId: number }
	| { type: "delete-message"; messageId: number }
	| {
			type: "put-data";
			scope:
				| { type: "conversation" }
				| { type: "message"; messageId: number }
				| { type: "variant"; messageId: number; variantId: number };
			namespace: string;
			key: string;
			value: string;
	  }
	| {
			type: "delete-data";
			scope:
				| { type: "conversation" }
				| { type: "message"; messageId: number }
				| { type: "variant"; messageId: number; variantId: number };
			namespace: string;
			key: string;
	  }
	| {
			type: "update-generation-settings";
			settings: ConversationGenerationSettings;
	  }
	| {
			type: "add-participant";
			definition: ParticipantDefinition;
	  }
	| { type: "rename-participant"; participantId: number; name: string }
	| {
			type: "replace-participant-prompt";
			participantId: number;
			prompt: ParticipantPrompt;
	  }
	| {
			type: "replace-participant-openings";
			participantId: number;
			openings: string[];
	  }
	| { type: "assign-control"; seat: "human" | "model"; participantId: number }
	// Removes an unseated Participant after confirmation. Seated Participants
	// are protected with the typed not-removable outcome; the impact is
	// shown from the snapshot before this command is sent.
	| { type: "remove-participant"; participantId: number };

// Note: the client-side add-participant action intentionally carries no
// sourceCharacterId. Character-to-Cast forks always go through
// addCharacterToCast (the workflow route), which checks the source
// Character and destination Conversation revisions server-side.

export type CommandOutcome =
	| { status: "applied"; conversation: ConversationSummary }
	| { status: "conflict"; currentConversation: ConversationSummary }
	| { status: "not-found" }
	| { status: "not-playable"; reason: string }
	// A seated Participant cannot be removed; the typed reason comes from the
	// server so clients never reconstruct the seat rule.
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
		if (error.status === 404) {
			return null;
		}
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
		// SAFETY: the transport contract declares the typed error union; the
		// discriminated `outcome` field narrows it before any payload access.
		const payload = error.value;
		if (payload.outcome === "conflict") {
			return {
				status: "conflict",
				currentConversation: payload.currentConversation,
			};
		}
		if (payload.outcome === "not-found") {
			return { status: "not-found" };
		}
		if (payload.outcome === "not-playable") {
			return { status: "not-playable", reason: payload.reason };
		}
		if (payload.outcome === "not-removable") {
			return { status: "not-removable", reason: payload.reason };
		}
		if (payload.outcome === "invalid") {
			return { status: "invalid", reason: payload.reason };
		}
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
		// SAFETY: the transport contract declares the typed error union; the
		// `outcome` field plus the presence of either authoritative payload
		// narrows which conflict kind was returned.
		const payload = error.value;
		if (payload.outcome === "conflict") {
			if ("currentConversation" in payload) {
				return { status: "conflict", currentConversation: payload.currentConversation };
			}
			return {
				status: "conflict",
				currentCharacterName: payload.currentCharacter.name,
			};
		}
		if (payload.outcome === "not-found") {
			return { status: "not-found" };
		}
		if (payload.outcome === "invalid") {
			return { status: "invalid", reason: payload.reason };
		}
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

// Promotes a Conversation-local Participant into a new reusable Character
// through the explicit workflow route. The server checks the expected
// Conversation revision and copies the authoritative server-side
// Participant Definition; the client never submits a Definition copy, so a
// stale one cannot become the new Character's source.
export async function saveParticipantAsCharacter(input: {
	conversationId: number;
	expectedConversationRevision: number;
	participantId: number;
}): Promise<SaveParticipantAsCharacterOutcome> {
	const { data, error } = await api.api
		.conversations({ id: input.conversationId })
		.cast.participants({ participantId: input.participantId })
		.characters.post({
			expectedConversationRevision: input.expectedConversationRevision,
		});
	if (error) {
		// SAFETY: the transport contract declares the typed error union; the
		// discriminated `outcome` field narrows it before any payload access.
		const payload = error.value;
		if (payload.outcome === "conflict") {
			return {
				status: "conflict",
				currentConversation: payload.currentConversation,
			};
		}
		if (payload.outcome === "not-found") {
			return { status: "not-found" };
		}
		if (payload.outcome === "invalid") {
			return { status: "invalid", reason: payload.reason };
		}
		return { status: "network" };
	}
	return { status: "applied", character: data.character };
}

export async function loadConversationGenerationSettings(
	conversationId: number,
): Promise<ConversationGenerationSettings> {
	const response = await fetch(`/api/conversations/${conversationId}/generation-settings`);
	if (!response.ok) throw new Error("Unable to load Conversation Generation Settings.");
	// SAFETY: the route's response contract is the Conversation Generation
	// Settings shape; this client function is the sole decoder for it.
	return (await response.json()) as ConversationGenerationSettings;
}

export type GenerationDetailsJsonValue =
	| string
	| number
	| boolean
	| null
	| GenerationDetailsJsonValue[]
	| { readonly [key: string]: GenerationDetailsJsonValue };

export type GenerationDetailsJsonObject = {
	readonly [key: string]: GenerationDetailsJsonValue;
};

export type GenerationInspectionStatus =
	| "active"
	| "complete"
	| "length-limited"
	| "interrupted";

export interface ActiveGenerationDetails {
	conversationId: number;
	generationId: number;
	messageId: number;
	variantId: number;
	startedAt: string;
	status: GenerationInspectionStatus;
	intent: GenerationDetailsJsonValue;
	participants: {
		human: { id: number; name: string };
		model: { id: number; name: string };
	};
	promptPlan: GenerationDetailsJsonValue;
	historyRoles: GenerationDetailsJsonValue;
	generationSettings: GenerationDetailsJsonValue;
	connection: GenerationDetailsJsonValue;
	budget: {
		tokenEstimate: number | null;
		responseBudget: number | null;
		safetyAllowance: number | null;
		contextLimit: number | null;
		totalRequiredTokens: number | null;
		omittedHistory: GenerationDetailsJsonValue;
	};
	checkpoint: {
		content: string;
		reasoning: string;
		latestEventId: number;
		checkpointedAt: string | null;
	};
}

export interface GenerationProvenance {
	connectionProfileId: number | null;
	connectionSettingsRevision: number | null;
	modelBackend: string | null;
	adapter: string | null;
	modelId: string | null;
	generationSettings: {
		temperature: number | null;
		topP: number | null;
		frequencyPenalty: number | null;
		presencePenalty: number | null;
		contextLimit: number | null;
		responseBudget: number | null;
		safetyAllowance: number | null;
		siblingGenerationLimit: number | null;
		continuationStrategy: "instruction" | "assistant-prefill" | null;
		continuationInstruction: string | null;
		continuationPrefillSuffix: "" | " " | "\n" | "\n\n" | null;
	};
	usage: Record<string, number> | null;
	finishReason: "stop" | "length" | "other" | null;
	status: "complete" | "length-limited" | "interrupted";
	interruptionCause: string | null;
}

export interface VariantDetails {
	conversationId: number;
	messageId: number;
	variantId: number;
	content: string;
	timestamp: string;
	author: {
		participantId: number | null;
		capturedName: string | null;
		inCast: boolean;
	} | null;
	historicalContext: {
		humanParticipantId: number;
		modelParticipantId: number;
	} | null;
	provenance: GenerationProvenance | null;
}

export type GenerationDetailsOutcome<T> =
	| { status: "available"; details: T }
	| { status: "not-found" }
	| { status: "network" };

const generationDetailsObject = (value: GenerationDetailsJsonValue | undefined): GenerationDetailsJsonObject | null => {
	if (Object.prototype.toString.call(value) !== "[object Object]") return null;
	// SAFETY: the object-tag check above establishes the JSON object shape before
	// this projection is used to inspect named detail fields.
	return value as GenerationDetailsJsonObject;
};

const generationDetailsNumber = (value: GenerationDetailsJsonValue | undefined): number | null => {
	if (Object.prototype.toString.call(value) !== "[object Number]") return null;
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
};

const generationDetailsString = (value: GenerationDetailsJsonValue | undefined): string | null =>
	Object.prototype.toString.call(value) === "[object String]" ? String(value) : null;

const generationDetailsBoolean = (value: GenerationDetailsJsonValue | undefined): boolean | null =>
	Object.prototype.toString.call(value) === "[object Boolean]" ? Boolean(value) : null;

const generationDetailsNullableNumber = (value: GenerationDetailsJsonValue | undefined): number | null =>
	value === null ? null : generationDetailsNumber(value);

type GenerationUsage = Record<string, number>;

const parseGenerationUsage = (value: GenerationDetailsJsonValue | undefined): GenerationUsage | null | undefined => {
	if (value === null) return null;
	const object = generationDetailsObject(value);
	if (object === null) return undefined;
	const usage: GenerationUsage = {};
	for (const [key, candidate] of Object.entries(object)) {
		const number = generationDetailsNumber(candidate);
		if (number === null || number < 0) return undefined;
		usage[key] = number;
	}
	return usage;
};

const parseGenerationProvenance = (
	value: GenerationDetailsJsonValue | undefined,
): GenerationProvenance | null | undefined => {
	if (value === null) return null;
	const object = generationDetailsObject(value);
	if (object === null) return undefined;
	const settings = generationDetailsObject(object.generationSettings);
	if (settings === null) return undefined;
	const status = generationDetailsString(object.status);
	if (status !== "complete" && status !== "length-limited" && status !== "interrupted") return undefined;
	const continuationStrategy = generationDetailsString(settings.continuationStrategy);
	const continuationPrefillSuffix = generationDetailsString(settings.continuationPrefillSuffix);
	const rawFinishReason = generationDetailsString(object.finishReason);
	const usage = parseGenerationUsage(object.usage);
	if (usage === undefined) return undefined;
	return {
		connectionProfileId: generationDetailsNullableNumber(object.connectionProfileId),
		connectionSettingsRevision: generationDetailsNullableNumber(object.connectionSettingsRevision),
		modelBackend: generationDetailsString(object.modelBackend),
		adapter: generationDetailsString(object.adapter),
		modelId: generationDetailsString(object.modelId),
		generationSettings: {
			temperature: generationDetailsNullableNumber(settings.temperature),
			topP: generationDetailsNullableNumber(settings.topP),
			frequencyPenalty: generationDetailsNullableNumber(settings.frequencyPenalty),
			presencePenalty: generationDetailsNullableNumber(settings.presencePenalty),
			contextLimit: generationDetailsNullableNumber(settings.contextLimit),
			responseBudget: generationDetailsNullableNumber(settings.responseBudget),
			safetyAllowance: generationDetailsNullableNumber(settings.safetyAllowance),
			siblingGenerationLimit: generationDetailsNullableNumber(settings.siblingGenerationLimit),
			continuationStrategy: continuationStrategy === "instruction" || continuationStrategy === "assistant-prefill"
				? continuationStrategy
				: null,
			continuationInstruction: generationDetailsString(settings.continuationInstruction),
			continuationPrefillSuffix: continuationPrefillSuffix === "" || continuationPrefillSuffix === " " || continuationPrefillSuffix === "\n" || continuationPrefillSuffix === "\n\n"
				? continuationPrefillSuffix
				: null,
		},
		usage,
		finishReason: rawFinishReason === "stop" || rawFinishReason === "length" || rawFinishReason === "other"
			? rawFinishReason
			: null,
		status,
		interruptionCause: generationDetailsString(object.interruptionCause),
	};
};

const parseActiveGenerationDetails = (value: GenerationDetailsJsonValue): ActiveGenerationDetails | null => {
	const object = generationDetailsObject(value);
	const participants = generationDetailsObject(object?.participants);
	const human = generationDetailsObject(participants?.human);
	const model = generationDetailsObject(participants?.model);
	const budget = generationDetailsObject(object?.budget);
	const checkpoint = generationDetailsObject(object?.checkpoint);
	const generationId = generationDetailsNumber(object?.generationId);
	const conversationId = generationDetailsNumber(object?.conversationId);
	const messageId = generationDetailsNumber(object?.messageId);
	const variantId = generationDetailsNumber(object?.variantId);
	const startedAt = generationDetailsString(object?.startedAt);
	const status = generationDetailsString(object?.status);
	const humanId = generationDetailsNumber(human?.id);
	const humanName = generationDetailsString(human?.name);
	const modelId = generationDetailsNumber(model?.id);
	const modelName = generationDetailsString(model?.name);
	const checkpointContent = generationDetailsString(checkpoint?.content);
	const checkpointReasoning = generationDetailsString(checkpoint?.reasoning);
	const checkpointEventId = generationDetailsNumber(checkpoint?.latestEventId);
	const checkpointedAt = checkpoint?.checkpointedAt === null ? null : generationDetailsString(checkpoint?.checkpointedAt);
	if (
		object === null || participants === null || human === null || model === null ||
		budget === null || checkpoint === null || generationId === null || conversationId === null ||
		messageId === null || variantId === null || startedAt === null ||
		(status !== "active" && status !== "complete" && status !== "length-limited" && status !== "interrupted") ||
		humanId === null || humanName === null || modelId === null || modelName === null ||
		checkpointContent === null || checkpointReasoning === null || checkpointEventId === null ||
		(checkpoint.checkpointedAt !== null && checkpointedAt === null)
	) return null;
	const numberOrNull = (candidate: GenerationDetailsJsonValue | undefined): number | null => candidate === null ? null : generationDetailsNumber(candidate);
	if (
		(budget.tokenEstimate !== null && generationDetailsNumber(budget.tokenEstimate) === null) ||
		(budget.responseBudget !== null && generationDetailsNumber(budget.responseBudget) === null) ||
		(budget.safetyAllowance !== null && generationDetailsNumber(budget.safetyAllowance) === null) ||
		(budget.contextLimit !== null && generationDetailsNumber(budget.contextLimit) === null) ||
		(budget.totalRequiredTokens !== null && generationDetailsNumber(budget.totalRequiredTokens) === null)
	) return null;
	return {
		conversationId,
		generationId,
		messageId,
		variantId,
		startedAt,
		status,
		intent: object.intent,
		participants: {
			human: { id: humanId, name: humanName },
			model: { id: modelId, name: modelName },
		},
		promptPlan: object.promptPlan,
		historyRoles: object.historyRoles,
		generationSettings: object.generationSettings,
		connection: object.connection,
		budget: {
			tokenEstimate: numberOrNull(budget.tokenEstimate),
			responseBudget: numberOrNull(budget.responseBudget),
			safetyAllowance: numberOrNull(budget.safetyAllowance),
			contextLimit: numberOrNull(budget.contextLimit),
			totalRequiredTokens: numberOrNull(budget.totalRequiredTokens),
			omittedHistory: budget.omittedHistory,
		},
		checkpoint: {
			content: checkpointContent,
			reasoning: checkpointReasoning,
			latestEventId: checkpointEventId,
			checkpointedAt,
		},
	};
};

const parseVariantDetails = (value: GenerationDetailsJsonValue): VariantDetails | null => {
	const object = generationDetailsObject(value);
	if (object === null) return null;
	const conversationId = generationDetailsNumber(object.conversationId);
	const messageId = generationDetailsNumber(object.messageId);
	const variantId = generationDetailsNumber(object.variantId);
	const content = generationDetailsString(object.content);
	const timestamp = generationDetailsString(object.timestamp);
	if (conversationId === null || messageId === null || variantId === null || content === null || timestamp === null) return null;
	const author = object.author === null ? null : (() => {
		const authorObject = generationDetailsObject(object.author);
		const participantId = generationDetailsNullableNumber(authorObject?.participantId);
		const capturedName = generationDetailsString(authorObject?.capturedName);
		const inCast = generationDetailsBoolean(authorObject?.inCast);
		return authorObject === null || inCast === null ? undefined : { participantId, capturedName, inCast };
	})();
	if (author === undefined) return null;
	const historicalContext = object.historicalContext === null ? null : (() => {
		const context = generationDetailsObject(object.historicalContext);
		const humanParticipantId = generationDetailsNumber(context?.humanParticipantId);
		const modelParticipantId = generationDetailsNumber(context?.modelParticipantId);
		return context === null || humanParticipantId === null || modelParticipantId === null
			? undefined
			: { humanParticipantId, modelParticipantId };
	})();
	if (historicalContext === undefined) return null;
	const provenance = parseGenerationProvenance(object.provenance);
	if (provenance === undefined) return null;
	return {
		conversationId,
		messageId,
		variantId,
		content,
		timestamp,
		author,
		historicalContext,
		provenance,
	};
};

export async function loadActiveGenerationDetails(
	conversationId: number,
	generationId: number,
): Promise<GenerationDetailsOutcome<ActiveGenerationDetails>> {
	try {
		const response = await fetch(`/api/conversations/${conversationId}/generations/${generationId}/inspection`);
		if (response.status === 404) return { status: "not-found" };
		if (!response.ok) return { status: "network" };
		// SAFETY: JSON responses contain only JSON-compatible values; the parser
		// validates the object and every field before exposing detail types.
		const value = await response.json() as GenerationDetailsJsonValue;
		const details = parseActiveGenerationDetails(value);
		return details === null ? { status: "network" } : { status: "available", details };
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
		const response = await fetch(`/api/conversations/${conversationId}/messages/${messageId}/variants/${variantId}/details`);
		if (response.status === 404) return { status: "not-found" };
		if (!response.ok) return { status: "network" };
		// SAFETY: JSON responses contain only JSON-compatible values; the parser
		// validates the object and every field before exposing detail types.
		const value = await response.json() as GenerationDetailsJsonValue;
		const details = parseVariantDetails(value);
		return details === null ? { status: "network" } : { status: "available", details };
	} catch {
		return { status: "network" };
	}
}

export const loadGenerationVariantDetails = loadVariantDetails;

export type StartConversationGenerationResult =
	| {
			outcome: "accepted";
			generationId: number;
			conversationId: number;
			messageId: number;
			variantId: number;
	  }
	| { outcome: "not-found" }
	| { outcome: "conflict" | "invalid" | "not-playable"; reason: string };

// Starts a server-owned generation without coupling acceptance to a browser
// stream. Call subscribeConversationGeneration separately for each observing
// client, including clients that reconnect after a reload.
export async function startConversationGeneration(
	conversationId: number,
	expectedRevision: number,
	content: string,
): Promise<StartConversationGenerationResult> {
	const response = await fetch(`/api/conversations/${conversationId}/generations`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ expectedRevision, content }),
	});
	let value: GenerationStreamJsonObject | null;
	try {
		// SAFETY: the object-tag check in generationStreamJsonObject validates the
		// untrusted JSON before any named field is consumed below.
		value = generationStreamJsonObject(await response.json());
	} catch { return { outcome: "invalid", reason: "Generation start returned malformed JSON." }; }
	if (value === null) return { outcome: "invalid", reason: "Generation start returned malformed JSON." };
	if (!response.ok) {
		if (isGenerationStartValue(value, "not-found")) return { outcome: "not-found" };
		if (isGenerationStartValue(value, "conflict")) return { outcome: "conflict", reason: value.reason ?? "Generation start conflicted with a newer Conversation revision." };
		if (isGenerationStartValue(value, "not-playable")) return { outcome: "not-playable", reason: value.reason ?? "The Conversation is not playable." };
		if (isGenerationStartValue(value, "invalid")) return { outcome: "invalid", reason: value.reason ?? "Generation could not be started." };
		return { outcome: "invalid", reason: "Generation could not be started." };
	}
	if (!isGenerationStartAccepted(value)) return { outcome: "invalid", reason: "Generation start returned malformed JSON." };
	return value;
}

export async function startConversationSiblingGeneration(
	conversationId: number,
	messageId: number,
): Promise<StartConversationGenerationResult> {
	const response = await fetch(`/api/conversations/${conversationId}/messages/${messageId}/sibling/generations`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	});
	let value: GenerationStreamJsonObject | null;
	try {
		// SAFETY: the object-tag check in generationStreamJsonObject validates the
		// untrusted JSON before any named field is consumed below.
		value = generationStreamJsonObject(await response.json());
	} catch { return { outcome: "invalid", reason: "Sibling Generation start returned malformed JSON." }; }
	if (value === null) return { outcome: "invalid", reason: "Sibling Generation start returned malformed JSON." };
	if (!response.ok) {
		if (isGenerationStartValue(value, "not-found")) return { outcome: "not-found" };
		if (isGenerationStartValue(value, "conflict")) return { outcome: "conflict", reason: value.reason ?? "Generation start conflicted with a newer Conversation revision." };
		if (isGenerationStartValue(value, "not-playable")) return { outcome: "not-playable", reason: value.reason ?? "The Conversation is not playable." };
		if (isGenerationStartValue(value, "invalid")) return { outcome: "invalid", reason: value.reason ?? "Sibling Generation could not be started." };
		return { outcome: "invalid", reason: "Sibling Generation could not be started." };
	}
	if (!isGenerationStartAccepted(value)) return { outcome: "invalid", reason: "Sibling Generation start returned malformed JSON." };
	return value;
}

export async function startConversationContinuationGeneration(
	conversationId: number,
	expectedRevision: number,
): Promise<StartConversationGenerationResult> {
	const response = await fetch(`/api/conversations/${conversationId}/continue/generations`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ expectedRevision }),
	});
	let value: GenerationStreamJsonObject | null;
	try {
		value = generationStreamJsonObject(await response.json());
	} catch {
		return { outcome: "invalid", reason: "Continuation Generation start returned malformed JSON." };
	}
	if (value === null) return { outcome: "invalid", reason: "Continuation Generation start returned malformed JSON." };
	if (!response.ok) {
		if (isGenerationStartValue(value, "not-found")) return { outcome: "not-found" };
		if (isGenerationStartValue(value, "conflict")) return { outcome: "conflict", reason: value.reason ?? "Generation start conflicted with a newer Conversation revision." };
		if (isGenerationStartValue(value, "not-playable")) return { outcome: "not-playable", reason: value.reason ?? "The Conversation is not playable." };
		if (isGenerationStartValue(value, "invalid")) return { outcome: "invalid", reason: value.reason ?? "Continuation Generation could not be started." };
		return { outcome: "invalid", reason: "Continuation Generation could not be started." };
	}
	if (!isGenerationStartAccepted(value)) {
		return { outcome: "invalid", reason: "Continuation Generation start returned malformed JSON." };
	}
	return value;
}

export type StopConversationGenerationResult =
	| { outcome: "stopped"; generationId?: number; conversation?: ConversationSummary }
	| { outcome: "not-found" }
	| { outcome: "failed"; reason: string };

// Stop is an explicit server command. The caller may separately abort its
// local subscription after this request; closing that subscription alone never
// reaches this function and therefore cannot cancel provider work.
export async function stopConversationGeneration(
	conversationId: number,
	generationId: number,
): Promise<StopConversationGenerationResult> {
	return postGenerationStop(`/api/conversations/${conversationId}/generations/${generationId}/stop`);
}

export async function stopAllConversationGenerations(
	conversationId: number,
): Promise<StopConversationGenerationResult & { generationIds?: number[] }> {
	return postGenerationStop(`/api/conversations/${conversationId}/generations/stop-all`, true);
}

async function postGenerationStop(
	path: string,
	all = false,
): Promise<StopConversationGenerationResult & { generationIds?: number[] }> {
	try {
		const response = await fetch(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		let value: GenerationStreamJsonObject | null;
		try {
			value = generationStreamJsonObject(await response.json());
		} catch {
			return { outcome: "failed", reason: "Stop Generation returned malformed JSON." };
		}
		if (value === null) return { outcome: "failed", reason: "Stop Generation returned malformed JSON." };
		if (!response.ok) {
			return generationStreamJsonString(value.outcome) === "not-found"
				? { outcome: "not-found" }
				: { outcome: "failed", reason: generationStreamJsonString(value.reason) ?? "Generation could not be stopped." };
		}
		if (generationStreamJsonString(value.outcome) !== "stopped") {
			return { outcome: "failed", reason: "Stop Generation returned an unexpected result." };
		}
		const generationId = generationStreamJsonNumber(value.generationId);
		const generationIdsValue = Array.isArray(value.generationIds)
			? value.generationIds.filter((candidate): candidate is number => generationStreamJsonNumber(candidate) !== undefined).map(Number)
			: undefined;
		const result: StopConversationGenerationResult & { generationIds?: number[] } = { outcome: "stopped" };
		if (generationId !== undefined) result.generationId = generationId;
		if (generationIdsValue !== undefined) result.generationIds = generationIdsValue;
		return result;
	} catch {
		return { outcome: "failed", reason: all ? "Generations could not be stopped." : "Generation could not be stopped." };
	}
}

// A GET subscription is deliberately separate from POST acceptance. Reloads
// and navigation can reconnect with the last observed event position without
// contacting the provider or creating another Generation.
export async function subscribeConversationGeneration(
	conversationId: number,
	generationId: number,
	input: {
		afterEventId?: number;
		signal?: AbortSignal;
		onDelta: (event: GenerationStreamDelta) => void;
		onState?: (state: GenerationStreamState) => void;
	},
): Promise<GenerationStreamResult> {
	const query = new URLSearchParams();
	if (input.afterEventId !== undefined) query.set("after", String(input.afterEventId));
	const suffix = query.size === 0 ? "" : `?${query.toString()}`;
	const response = await fetch(
		`/api/conversations/${conversationId}/generations/${generationId}/events${suffix}`,
		{ method: "GET", signal: input.signal },
	);
	if (!response.ok || response.body === null) {
		return { outcome: "failed", reason: "Generation subscription could not be opened." };
	}
	return consumeGenerationStream(response, input);
}

async function consumeGenerationStream(
	response: Response,
	input: {
		onDelta: (event: GenerationStreamDelta) => void;
		onState?: (state: GenerationStreamState) => void;
	},
): Promise<GenerationStreamResult> {
	const body = response.body;
	if (body === null) {
		return { outcome: "failed", reason: "Generation stream had no body." };
	}
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	let result: GenerationStreamResult | null = null;
	let lastEventId = 0;
	const consumeFrame = (frame: string) => {
		let eventType = "message";
		let frameId: number | undefined;
		let malformedId = false;
		const dataLines: string[] = [];
		for (const line of frame.split(/\r?\n/)) {
			if (line.startsWith("event:")) eventType = line.slice(6).trim();
			if (line.startsWith("id:")) {
				const candidate = Number(line.slice(3).trim());
				if (!Number.isInteger(candidate) || candidate < 1) malformedId = true;
				else frameId = candidate;
			}
			if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
		}
		if (dataLines.length === 0) return;
		if (malformedId) return;
		const value = parseGenerationStreamObject(dataLines.join("\n"));
		if (value === null) return;
		const delta = eventType === "generation" ? parseGenerationStreamDelta(value) : null;
		if (delta !== null) {
			if (frameId !== undefined) {
				if (frameId <= lastEventId) return;
				lastEventId = frameId;
			}
			input.onDelta(delta);
			return;
		}
		const state = eventType === "state" ? parseGenerationStreamState(value) : null;
		if (state !== null) {
			lastEventId = Math.max(lastEventId, state.latestEventId);
			input.onState?.(state);
			return;
		}
		const applied = eventType === "complete" ? parseGenerationApplied(value) : null;
		if (applied !== null) {
			result = applied;
			return;
		}
		const stopped = eventType === "stopped" ? parseGenerationStopped(value) : null;
		if (stopped !== null) {
			result = stopped;
			return;
		}
		const failure = eventType === "error" ? parseGenerationFailure(value) : null;
		if (failure !== null) result = failure;
	};
	while (true) {
		const next = await reader.read();
		pending += decoder.decode(next.value ?? new Uint8Array(), { stream: !next.done });
		const frames = pending.split(/\r?\n\r?\n/);
		pending = frames.pop() ?? "";
		for (const frame of frames) consumeFrame(frame);
		if (next.done) break;
	}
	if (pending.length > 0) consumeFrame(pending);
	return result ?? { outcome: "failed", reason: "Generation ended without a terminal result." };
}

type GenerationStreamJsonValue =
	| string
	| number
	| boolean
	| null
	| GenerationStreamJsonValue[]
	| { readonly [key: string]: GenerationStreamJsonValue };

type GenerationStreamJsonObject = {
	readonly [key: string]: GenerationStreamJsonValue;
};

function parseGenerationStreamObject(serialized: string): GenerationStreamJsonObject | null {
	let parsed: GenerationStreamJsonValue;
	try {
		// SAFETY: JSON.parse is followed by an object-tag check before this value
		// crosses into the small SSE payload decoders below.
		parsed = JSON.parse(serialized) as GenerationStreamJsonValue;
	} catch {
		return null;
	}
	return generationStreamJsonObject(parsed);
}

function isGenerationStartValue(
	value: GenerationStreamJsonObject,
		outcome: "not-found" | "conflict" | "invalid" | "not-playable",
): value is GenerationStreamJsonObject & { outcome: typeof outcome; reason?: string } {
	return generationStreamJsonString(value.outcome) === outcome;
}

function isGenerationStartAccepted(
	value: GenerationStreamJsonObject,
): value is GenerationStreamJsonObject & {
	outcome: "accepted";
	generationId: number;
	conversationId: number;
	messageId: number;
	variantId: number;
} {
	return generationStreamJsonString(value.outcome) === "accepted" &&
		generationStreamJsonNumber(value.generationId) !== undefined &&
		generationStreamJsonNumber(value.conversationId) !== undefined &&
		generationStreamJsonNumber(value.messageId) !== undefined &&
		generationStreamJsonNumber(value.variantId) !== undefined;
}

function parseGenerationStreamDelta(value: GenerationStreamJsonObject): GenerationStreamDelta | null {
	const type = generationStreamJsonString(value.type);
	if (type === "content" || type === "reasoning") {
		const text = generationStreamJsonString(value.text);
		return text === undefined ? null : { type, text };
	}
	if (type === "keepalive") return { type };
	if (type === "usage") {
		const usageObject = generationStreamJsonObject(value.usage);
		if (usageObject === null) return null;
		const usage: Record<string, number> = {};
		for (const [key, candidate] of Object.entries(usageObject)) {
			const number = generationStreamJsonNumber(candidate);
			if (number !== undefined) usage[key] = number;
		}
		return { type, usage };
	}
	if (type !== "finished") return null;
	const finishReason = generationStreamJsonString(value.finishReason);
	if (finishReason !== "stop" && finishReason !== "length" && finishReason !== "other") return null;
	return { type, finishReason };
}

function parseGenerationStreamState(value: GenerationStreamJsonObject): GenerationStreamState | null {
	if (generationStreamJsonString(value.outcome) !== "active-state") return null;
	const generationId = generationStreamJsonNumber(value.generationId);
	const conversationId = generationStreamJsonNumber(value.conversationId);
	const messageId = generationStreamJsonNumber(value.messageId);
	const variantId = generationStreamJsonNumber(value.variantId);
	const content = generationStreamJsonString(value.content);
	const reasoning = generationStreamJsonString(value.reasoning);
	const latestEventId = generationStreamJsonNumber(value.latestEventId);
	const status = generationStreamJsonString(value.status);
	const terminalReason = value.terminalReason === null
		? null
		: generationStreamJsonString(value.terminalReason);
	if (
		generationId === undefined || conversationId === undefined || messageId === undefined ||
		variantId === undefined || content === undefined || reasoning === undefined ||
		latestEventId === undefined || (status !== "active" && status !== "complete" && status !== "stopped" && status !== "failed") ||
		terminalReason === undefined
	) return null;
	return {
		generationId,
		conversationId,
		messageId,
		variantId,
		content,
		reasoning,
		latestEventId,
		status,
		terminalReason,
	};
}

function parseGenerationApplied(
	value: GenerationStreamJsonObject,
): Extract<GenerationStreamResult, { outcome: "applied" }> | null {
	if (generationStreamJsonString(value.outcome) !== "applied") return null;
	return { outcome: "applied" };
}

function parseGenerationStopped(
	value: GenerationStreamJsonObject,
): Extract<GenerationStreamResult, { outcome: "stopped" }> | null {
	if (generationStreamJsonString(value.outcome) !== "stopped") return null;
	const generationId = generationStreamJsonNumber(value.generationId);
	return generationId === undefined ? { outcome: "stopped" } : { outcome: "stopped", generationId };
}

function parseGenerationFailure(
	value: GenerationStreamJsonObject,
): Exclude<GenerationStreamResult, { outcome: "applied" }> | null {
	const outcome = generationStreamJsonString(value.outcome);
	if (outcome === "not-found") return { outcome };
	if (outcome !== "not-playable" && outcome !== "failed" && outcome !== "invalid" && outcome !== "conflict") return null;
	const reason = generationStreamJsonString(value.reason);
	return reason === undefined ? null : { outcome, reason };
}

function generationStreamJsonObject(value: GenerationStreamJsonValue | undefined): GenerationStreamJsonObject | null {
	if (Object.prototype.toString.call(value) !== "[object Object]") return null;
	// SAFETY: the object-tag check above establishes the JSON object shape before
	// this named projection is used by the stream decoders.
	return value as GenerationStreamJsonObject;
}

function generationStreamJsonString(value: GenerationStreamJsonValue | undefined): string | undefined {
	if (Object.prototype.toString.call(value) !== "[object String]") return undefined;
	return String(value);
}

function generationStreamJsonNumber(value: GenerationStreamJsonValue | undefined): number | undefined {
	if (Object.prototype.toString.call(value) !== "[object Number]") return undefined;
	const number = Number(value);
	return Number.isFinite(number) ? number : undefined;
}
