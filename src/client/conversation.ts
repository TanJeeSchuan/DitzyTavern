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
	| { outcome: "not-found" }
	| { outcome: "not-playable" | "unconfigured" | "failed" | "invalid" | "conflict"; reason: string };

export type GenerationStreamDelta =
	| { type: "content"; text: string }
	| { type: "reasoning"; text: string }
	| { type: "usage"; usage: Record<string, number> }
	| { type: "finished"; finishReason: "stop" | "length" | "other"; rawFinishReason?: string }
	| { type: "keepalive" };

export interface GenerationStreamState {
	generationId: number;
	conversationId: number;
	messageId: number;
	variantId: number;
	content: string;
	reasoning: string;
	latestEventId: number;
	status: "active" | "complete" | "failed";
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

export type StartConversationGenerationResult =
	| {
			outcome: "accepted";
			generationId: number;
			conversationId: number;
			messageId: number;
			variantId: number;
	  }
	| { outcome: "not-found" | "conflict" | "invalid"; reason?: string };

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
		if (isGenerationStartValue(value, "conflict") || isGenerationStartValue(value, "invalid")) {
			return { outcome: value.outcome, reason: value.reason };
		}
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
		if (isGenerationStartValue(value, "conflict") || isGenerationStartValue(value, "invalid")) {
			return { outcome: value.outcome, reason: value.reason };
		}
		return { outcome: "invalid", reason: "Sibling Generation could not be started." };
	}
	if (!isGenerationStartAccepted(value)) return { outcome: "invalid", reason: "Sibling Generation start returned malformed JSON." };
	return value;
}

// POST generation uses a native fetch stream because EventSource cannot send
// a request body. Frames are decoded and validated here before the workspace
// sees visible text; malformed provider or server payloads never become UI
// state.
export async function streamConversationReply(
	conversationId: number,
	input: {
		endpoint?: "generate" | "continue";
		expectedRevision?: number;
		content?: string;
		signal?: AbortSignal;
		onDelta: (event: GenerationStreamDelta) => void;
		onAccepted?: (generationId: number) => void;
		onState?: (state: GenerationStreamState) => void;
		afterEventId?: number;
	},
): Promise<GenerationStreamResult> {
	const endpoint = input.endpoint === "continue" ? "continue" : "generate";
	const response = await fetch(`/api/conversations/${conversationId}/${endpoint}/stream`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: input.expectedRevision === undefined && input.content === undefined
			? "{}"
			: JSON.stringify({ expectedRevision: input.expectedRevision, content: input.content }),
		signal: input.signal,
	});
	if (!response.ok || response.body === null) {
		return { outcome: "failed", reason: "Generation stream could not be opened." };
	}
	return consumeGenerationStream(response, input);
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
		`/api/conversations/${conversationId}/generate/stream/${generationId}${suffix}`,
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
		onAccepted?: (generationId: number) => void;
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
		const accepted = eventType === "accepted" ? parseGenerationAccepted(value) : null;
		if (accepted !== null) {
			input.onAccepted?.(accepted.generationId);
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

export function streamConversationContinuation(
	conversationId: number,
	input: {
		expectedRevision: number;
		signal?: AbortSignal;
		onDelta: (event: GenerationStreamDelta) => void;
		onAccepted?: (generationId: number) => void;
	},
): Promise<GenerationStreamResult> {
	return streamConversationReply(conversationId, { ...input, endpoint: "continue" });
}

// Starts and observes a server-owned Sibling Generation at one existing
// Message. Each call receives its own Generation/event IDs, so parallel
// sibling streams share the decoder without provider-specific handling.
export function streamConversationSibling(
	conversationId: number,
	messageId: number,
	input: {
		signal?: AbortSignal;
		onDelta: (event: GenerationStreamDelta) => void;
		onAccepted?: (generationId: number) => void;
		onState?: (state: GenerationStreamState) => void;
	},
): Promise<GenerationStreamResult> {
	return fetch(`/api/conversations/${conversationId}/messages/${messageId}/sibling/stream`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
		signal: input.signal,
	}).then((response) => {
		if (!response.ok || response.body === null) {
			return { outcome: "failed", reason: "Sibling Generation stream could not be opened." } satisfies GenerationStreamResult;
		}
		return consumeGenerationStream(response, input);
	});
}

export const streamConversationContinue = streamConversationContinuation;

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
	outcome: "not-found" | "conflict" | "invalid",
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
	const rawFinishReason = generationStreamJsonString(value.rawFinishReason);
	return rawFinishReason === undefined
		? { type, finishReason }
		: { type, finishReason, rawFinishReason };
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
		latestEventId === undefined || (status !== "active" && status !== "complete" && status !== "failed") ||
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

function parseGenerationAccepted(
	value: GenerationStreamJsonObject,
): { outcome: "accepted"; generationId: number } | null {
	if (generationStreamJsonString(value.outcome) !== "accepted") return null;
	const generationId = generationStreamJsonNumber(value.generationId);
	return generationId === undefined
		? null
		: { outcome: "accepted", generationId };
}

function parseGenerationFailure(
	value: GenerationStreamJsonObject,
): Exclude<GenerationStreamResult, { outcome: "applied" }> | null {
	const outcome = generationStreamJsonString(value.outcome);
	if (outcome === "not-found") return { outcome };
	if (outcome !== "not-playable" && outcome !== "unconfigured" && outcome !== "failed" && outcome !== "invalid" && outcome !== "conflict") return null;
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
