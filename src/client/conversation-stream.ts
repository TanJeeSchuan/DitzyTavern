// The Conversation JSON routes use the typed Eden client. This module owns
// the one deliberately manual protocol: the resumable Generation SSE stream.

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
		if (dataLines.length === 0 || malformedId) return;
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
