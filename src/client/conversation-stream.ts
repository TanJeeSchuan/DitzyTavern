// The Conversation JSON routes use the typed Eden client. This module owns
// the one deliberately manual protocol: the resumable Generation SSE stream.
// SSE framing, comments, partial frames, HTTP status interpretation, and
// network failure mapping stay owned here; every frame payload is decoded
// against the shared Generation event vocabulary
// (src/shared/contract/generation-events) before an application callback or
// stream result sees it, so a malformed payload can never masquerade as a
// trusted Generation event.

import {
	generationAppliedPayload,
	generationEvent,
	generationFailurePayload,
	generationStatePayload,
	generationStoppedPayload,
	type GenerationEvent,
	type GenerationStatePayload,
} from "../shared/contract/generation-events";
import type { JsonValue } from "./lib/json-guards";
import { decodeWirePayload } from "./lib/wire-decode";

export type GenerationStreamResult =
	| { outcome: "applied" }
	| { outcome: "stopped"; generationId?: number }
	| { outcome: "not-found" }
	| { outcome: "not-playable" | "failed" | "invalid" | "conflict"; reason: string };

// Stream deltas are the shared normalized Generation event union, and state
// snapshots are the shared state payload: server production and client
// consumption use one schema-owned vocabulary.
export type GenerationStreamDelta = GenerationEvent;
export type GenerationStreamState = GenerationStatePayload;

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

// The SSE data line is the transport's JSON parse target; the decoded value
// is only trusted after a shared contract schema accepts it.
const parseStreamPayload = (serialized: string): JsonValue | null => {
	try {
		// SAFETY: JSON.parse produces exactly the JsonValue vocabulary above; the
		// value is still untrusted until the shared schema decode accepts it.
		return JSON.parse(serialized) as JsonValue;
	} catch {
		return null;
	}
};

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
		const payload = parseStreamPayload(dataLines.join("\n"));
		if (payload === null) return;
		if (eventType === "generation") {
			const event = decodeWirePayload(generationEvent, payload);
			if (event === null) return;
			if (frameId !== undefined) {
				if (frameId <= lastEventId) return;
				lastEventId = frameId;
			}
			input.onDelta(event);
			return;
		}
		if (eventType === "state") {
			const state = decodeWirePayload(generationStatePayload, payload);
			if (state === null) return;
			lastEventId = Math.max(lastEventId, state.latestEventId);
			input.onState?.(state);
			return;
		}
		if (eventType === "complete") {
			if (decodeWirePayload(generationAppliedPayload, payload) !== null) result = { outcome: "applied" };
			return;
		}
		if (eventType === "stopped") {
			const stopped = decodeWirePayload(generationStoppedPayload, payload);
			if (stopped !== null) result = { outcome: "stopped", generationId: stopped.generationId };
			return;
		}
		if (eventType === "error") {
			const failure = decodeWirePayload(generationFailurePayload, payload);
			if (failure === null) return;
			result = failure.outcome === "not-found"
				? { outcome: "not-found" }
				: { outcome: failure.outcome, reason: failure.reason };
		}
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
