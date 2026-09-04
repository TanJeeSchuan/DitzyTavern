// The session runner: a framework-free coordinator between the pure
// ==[HUMAN APPROVED]== Generation session machine and its effects. Every machine transition
// returns ordered effects; this runner is the only component that executes
// them — opening and closing subscriptions through the injected stream
// adapter (the production SSE adapter or a fake one), forwarding story
// effects to the host, and requesting authoritative Conversation refreshes.
// The React hook wires hosts onto this runner; it owns no session behavior.

import type {
	GenerationStreamAdapter,
	GenerationStreamResult,
} from "./conversation-stream";
import {
	createGenerationSessions,
	reduceGenerationSessions,
	type GenerationSessionEffect,
	type GenerationSessionStoryEffect,
	type GenerationSessionsAction,
	type GenerationSessionsState,
} from "./generation-sessions";

// The host surfaces the runner's outward effects. Story effects are mapped
// ==[HUMAN APPROVED]== by the host (which owns the story reducer boundary); refresh requests go
// to the authoritative Conversation read.
export interface GenerationSessionRunnerHost {
	adapter: GenerationStreamAdapter;
	applyStoryEffect: (effect: GenerationSessionStoryEffect) => void;
	refreshConversation: (conversationId: number) => void;
}

export interface GenerationSessionRunner {
	dispatch: (action: GenerationSessionsAction) => void;
	getSnapshot: () => GenerationSessionsState;
	subscribe: (listener: () => void) => () => void;
	// Closes every live local subscription. This is teardown only: it never
	// ==[HUMAN APPROVED]== reaches a Stop command, so navigation and unmounting can never cancel a
	// server-owned Active Generation.
	dispose: () => void;
}

export function createGenerationSessionRunner(host: GenerationSessionRunnerHost): GenerationSessionRunner {
	let state = createGenerationSessions();
	const controllers = new Map<number, AbortController>();
	const listeners = new Set<() => void>();
	let disposed = false;

	const getSnapshot = (): GenerationSessionsState => state;

	const subscribe = (listener: () => void): (() => void) => {
		if (disposed) return () => {};
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	};

	const notify = (): void => {
		if (disposed) return;
		for (const listener of listeners) listener();
	};

	const dispatch = (action: GenerationSessionsAction): void => {
		if (disposed) return;
		const transition = reduceGenerationSessions(state, action);
		if (transition.state === state) return;
		state = transition.state;
		notify();
		for (const effect of transition.effects) runEffect(effect);
	};

	const runEffect = (effect: GenerationSessionEffect): void => {
		switch (effect.kind) {
			case "subscribe": {
				// One controller per subscription; a re-subscription closes any
				// ==[HUMAN APPROVED]== leftover stream for the same Generation first.
				const previous = controllers.get(effect.generationId);
				previous?.abort();
				const controller = new AbortController();
				controllers.set(effect.generationId, controller);
				void host.adapter.subscribe({
					conversationId: effect.conversationId,
					generationId: effect.generationId,
					messageId: effect.messageId,
					variantId: effect.variantId,
					afterEventId: effect.afterEventId,
					signal: controller.signal,
					onEvent: (observation) => {
						if (controller.signal.aborted) return;
						dispatch({
							type: "event-observed",
							generationId: effect.generationId,
							eventId: observation.eventId,
							event: observation.event,
						});
					},
					onState: (payload) => {
						if (controller.signal.aborted) return;
						dispatch({
							type: "state-observed",
							generationId: effect.generationId,
							state: payload,
						});
					},
				}).then((result: GenerationStreamResult) => {
					if (controllers.get(effect.generationId) === controller) {
						controllers.delete(effect.generationId);
					}
					if (controller.signal.aborted) return;
					dispatch({
						type: "subscription-settled",
						generationId: effect.generationId,
						result,
					});
				}).catch(() => {
					if (controllers.get(effect.generationId) === controller) {
						controllers.delete(effect.generationId);
					}
					if (controller.signal.aborted) return;
					dispatch({
						type: "subscription-settled",
						generationId: effect.generationId,
						result: { outcome: "interrupted", reason: "Generation subscription was interrupted." },
					});
				});
				return;
			}
			case "unsubscribe": {
				const controller = controllers.get(effect.generationId);
				if (controller !== undefined) {
					controller.abort();
					controllers.delete(effect.generationId);
				}
				return;
			}
			case "refresh-conversation":
				host.refreshConversation(effect.conversationId);
				return;
			case "story-content-delta":
			case "story-content-replace":
			case "story-reasoning-delta":
			case "story-reasoning-replace":
				host.applyStoryEffect(effect);
				return;
		}
	};

	return {
		dispatch,
		getSnapshot,
		subscribe,
		dispose: () => {
			if (disposed) return;
			for (const controller of controllers.values()) controller.abort();
			controllers.clear();
			// Detach the machine as well: a surface that stops observing loses
			// ==[HUMAN APPROVED]== its live subscriptions, and a later surface reattaches from the
			// sessions' cursors instead of resuming dead "subscribing" rows.
			// The detach updates silently: disposal itself never notifies, and
			// later work cannot reach subscribers.
			const transition = reduceGenerationSessions(state, { type: "conversation-switched" });
			state = transition.state;
			listeners.clear();
			disposed = true;
		},
	};
}
