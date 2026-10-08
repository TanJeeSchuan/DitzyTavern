// @approved
// The session runner: a framework-free coordinator between the pure
//  Generation session machine and its effects. Every machine transition
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
import { NetworkError } from "./lib/request-outcome";

// @approved
// The host surfaces the runner's outward effects. Story effects are mapped
//  by the host (which owns the story reducer boundary); refresh requests go
// to the authoritative Conversation read.
export interface GenerationSessionRunnerHost {
	adapter: GenerationStreamAdapter;
	applyStoryEffect: (effect: GenerationSessionStoryEffect) => void;
	refreshConversation: (conversationId: number, signal: AbortSignal) => Promise<void>;
}

export interface GenerationSessionRunner {
	dispatch: (action: GenerationSessionsAction) => void;
	getSnapshot: () => GenerationSessionsState;
	subscribe: (listener: () => void) => () => void;
	// @approved
	// Closes every live local subscription. This is teardown only: it never
	//  reaches a Stop command, so navigation and unmounting can never cancel a
	// server-owned Active Generation.
	dispose: () => void;
}

export function createGenerationSessionRunner(host: GenerationSessionRunnerHost): GenerationSessionRunner {
	let state = createGenerationSessions();
	const controllers = new Map<number, AbortController>();
	const listeners = new Set<() => void>();
	let disposed = false;
	type Refresh = { controller: AbortController; timer: ReturnType<typeof setTimeout> | null; requested: boolean };
	let refresh: Refresh | null = null;

	const cancelRefresh = (): void => {
		if (refresh === null) return;
		refresh.controller.abort();
		if (refresh.timer !== null) clearTimeout(refresh.timer);
		refresh = null;
	};

	const refreshConversation = (conversationId: number): void => {
		if (refresh !== null) {
			refresh.requested = true;
			return;
		}
		const pending: Refresh = { controller: new AbortController(), timer: null, requested: false };
		refresh = pending;
		const attempt = async (delay = 250): Promise<void> => {
			pending.requested = false;
			try {
				await host.refreshConversation(conversationId, pending.controller.signal);
				if (pending.controller.signal.aborted) return;
				if (pending.requested) void attempt();
				else refresh = null;
			} catch (error) {
				if (pending.controller.signal.aborted) return;
				if (error instanceof NetworkError) {
					pending.timer = setTimeout(() => {
						pending.timer = null;
						void attempt(Math.min(delay * 2, 2_000));
					}, delay);
				} else refresh = null;
			}
		};
		void attempt();
	};

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
		if (transition.state.activeConversationId !== state.activeConversationId) cancelRefresh();
		state = transition.state;
		notify();
		for (const effect of transition.effects) runEffect(effect);
	};

	const runEffect = (effect: GenerationSessionEffect): void => {
		switch (effect.kind) {
			case "subscribe": {
				// @approved
				// One controller per subscription; a re-subscription closes any
				//  leftover stream for the same Generation first.
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
				}).catch((): GenerationStreamResult => ({
					outcome: "interrupted", reason: "Generation subscription was interrupted.",
				})).then((result: GenerationStreamResult) => {
					if (controllers.get(effect.generationId) === controller) controllers.delete(effect.generationId);
					if (!controller.signal.aborted) dispatch({ type: "subscription-settled", generationId: effect.generationId, result });
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
				refreshConversation(effect.conversationId);
				return;
			case "story":
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
			cancelRefresh();
			for (const controller of controllers.values()) controller.abort();
			controllers.clear();
			// @approved
			// Detach the machine as well: a surface that stops observing loses
			//  its live subscriptions, and a later surface reattaches from the
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
