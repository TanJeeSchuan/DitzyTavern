import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { StoryVariant } from "../story";

// @approved
//  One observation of an Active Generation's stream for its Provisional Variant. A snapshot replaces both
// streams at once, since the wire snapshot carries them under one event id; a delta appends to its own stream.
export type VariantObservation = { messageId: number; variantId: number; generationId: number; eventId: number } & (
	| { mode: "replace"; content: string; reasoning: string }
	| { mode: "append"; stream: "content" | "reasoning"; text: string }
);

type Streamed = { generationId: number; eventId: number; content: string; reasoning: string };

// @approved
//  The streamed text an observation builds on: this Generation's own stream or the page's live checkpoint,
// whichever is newer. A Variant no page holds yet starts empty and is shown once a page places it live; a
// Variant the page holds outside this Generation takes none.
const baseOf = (streamed: Streamed | undefined, generationId: number, placed: StoryVariant | undefined): Streamed | undefined => {
	const own = streamed?.generationId === generationId ? streamed : undefined;
	const checkpoint = placed?.generationId === generationId
		? { generationId, eventId: placed.lastEventId ?? 0, content: placed.content ?? "", reasoning: placed.reasoning ?? "" }
		: undefined;
	if (own !== undefined && checkpoint !== undefined) return own.eventId >= checkpoint.eventId ? own : checkpoint;
	return own ?? checkpoint ?? (placed === undefined ? { generationId, eventId: 0, content: "", reasoning: "" } : undefined);
};

export const applyObservation = (streamed: Streamed | undefined, observation: VariantObservation, placed: StoryVariant | undefined): Streamed | undefined => {
	const base = baseOf(streamed, observation.generationId, placed);
	if (base === undefined || observation.eventId <= base.eventId) return undefined;
	const { generationId, eventId } = observation;
	if (observation.mode === "replace") return { generationId, eventId, content: observation.content, reasoning: observation.reasoning };
	return observation.stream === "content"
		? { ...base, eventId, content: base.content + observation.text }
		: { ...base, eventId, reasoning: base.reasoning + observation.text };
};

// @approved
//  The Variant as the story shows it: its stream while the page still holds the same Generation live at an
// older event. A settled page is the authority, so a stream that missed its end never stands in for it.
export const streamedVariant = (variant: StoryVariant, streamed: Streamed | undefined): StoryVariant =>
	streamed === undefined || variant.generationId !== streamed.generationId || streamed.eventId <= (variant.lastEventId ?? 0)
		? variant
		: {
				...variant,
				content: streamed.content,
				reasoning: streamed.reasoning,
				hasReasoning: variant.hasReasoning || streamed.reasoning !== "",
				empty: streamed.content === "",
				lastEventId: streamed.eventId,
			};

// @approved
//  Streamed text lives here, outside story state, so a chunk re-renders only the Message showing its Variant.
export function createVariantStreams() {
	const streams = new Map<number, Streamed>();
	const listeners = new Map<number, Set<() => void>>();
	const notify = (variantId: number) => {
		for (const listener of listeners.get(variantId) ?? []) listener();
	};
	const remove = (variantId: number) => {
		if (streams.delete(variantId)) notify(variantId);
	};
	return {
		/** @approved `placed` is the Variant as the story's page holds it, if it holds it. */
		observe(observation: VariantObservation, placed: StoryVariant | undefined) {
			const next = applyObservation(streams.get(observation.variantId), observation, placed);
			if (next === undefined) return;
			streams.set(observation.variantId, next);
			notify(observation.variantId);
		},
		checkpoint(variants: readonly StoryVariant[]) {
			for (const variant of variants) {
				if (variant.generationId === undefined) { remove(variant.id); continue; }
				const previous = streams.get(variant.id);
				const next = baseOf(previous, variant.generationId, variant);
				if (next === undefined || next === previous) continue;
				streams.set(variant.id, next);
				notify(variant.id);
			}
		},
		retain(generationIds: ReadonlySet<number>) {
			for (const [variantId, stream] of streams) if (!generationIds.has(stream.generationId)) remove(variantId);
		},
		get: (variantId: number) => streams.get(variantId),
		subscribe(variantId: number, listener: () => void) {
			const own = listeners.get(variantId) ?? new Set();
			listeners.set(variantId, own.add(listener));
			return () => { if (own.delete(listener) && own.size === 0) listeners.delete(variantId); };
		},
	};
}

export type VariantStreams = ReturnType<typeof createVariantStreams>;

export const VariantStreamsContext = createContext<VariantStreams>(createVariantStreams());

export function useStreamedVariant(variant: StoryVariant | undefined) {
	const streams = useContext(VariantStreamsContext);
	const id = variant?.id;
	const subscribe = useCallback((listener: () => void) => id === undefined ? () => undefined : streams.subscribe(id, listener), [streams, id]);
	const streamed = useSyncExternalStore(subscribe, () => id === undefined ? undefined : streams.get(id));
	return variant === undefined ? undefined : streamedVariant(variant, streamed);
}
