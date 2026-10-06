import { describe, expect, test } from "bun:test";
import type { GenerationEvent, GenerationStatePayload } from "../shared/contract/generation-events";
import type { GenerationStreamResult } from "./conversation-stream";
import {
	createGenerationSessions,
	firstActiveGenerationSessionFailure,
	hasActiveGenerationSessions,
	hasPendingGenerationStop,
	MAX_SESSION_RECONNECTS,
	reduceGenerationSessions,
	type GenerationSessionEffect,
	type GenerationSessionTerminal,
	type GenerationSessionsState,
	type GenerationSessionTarget,
} from "./generation-sessions";

// Pure transition tests for the client Generation session collection. Every
// test drives the reducer with transport-typed observations and reads state
// plus ordered effects out, so subscription phases, cursors, stop state,
// errors, and terminal handling stay verifiable without React or a network.

const target = (
	generationId: number,
	overrides: Partial<GenerationSessionTarget> = {},
): GenerationSessionTarget => ({
	generationId,
	messageId: 900 + generationId,
	variantId: 9_000 + generationId,
	...overrides,
});

const targetsFor = (...generationIds: readonly number[]): readonly GenerationSessionTarget[] =>
	generationIds.map((generationId) => target(generationId));

const observed = (generationIds: readonly number[]) =>
	({ type: "targets-observed", conversationId: 42, targets: targetsFor(...generationIds) }) as const;

const contentEvent = (text: string): GenerationEvent => ({ type: "content", text });
const reasoningEvent = (text: string): GenerationEvent => ({ type: "reasoning", text });

const stateText = (state: GenerationSessionsState, generationId: number) =>
	state.sessions.get(generationId);

const run = (state: GenerationSessionsState, action: Parameters<typeof reduceGenerationSessions>[1]) =>
	reduceGenerationSessions(state, action);

const sessionOf = (conversationId: number, targets: readonly GenerationSessionTarget[]) => {
	let state = createGenerationSessions();
	state = run(state, { type: "targets-observed", conversationId, targets }).state;
	return state;
};

describe("the Generation session collection", () => {
	test("creates subscribing sessions for newly observed targets and subscribes from event zero", () => {
		const { state, effects } = run(createGenerationSessions(), observed([7, 8]));

		expect(state.activeConversationId).toBe(42);
		expect([...state.sessions.keys()]).toEqual([7, 8]);
		expect(state.sessions.get(7)?.phase).toBe("subscribing");
		expect(state.sessions.get(7)?.lastEventId).toBe(0);
		expect(state.sessions.get(7)?.stopPending).toBe(false);
		expect(effects).toEqual([
			{ kind: "subscribe", conversationId: 42, generationId: 7, messageId: 907, variantId: 9_007, afterEventId: 0 },
			{ kind: "subscribe", conversationId: 42, generationId: 8, messageId: 908, variantId: 9_008, afterEventId: 0 },
		]);
		expect(hasActiveGenerationSessions(state)).toBe(true);
	});

	test("reconciliation with unchanged targets is a no-op", () => {
		const state = sessionOf(42, targetsFor(7));

		const reconciled = run(state, observed([7]));
		expect(reconciled.state).toBe(state);
		expect(reconciled.effects).toEqual([]);
	});

	test("tracks concurrent Sibling sessions independently", () => {
		let state = sessionOf(42, targetsFor(7, 8));

		const first = run(state, {
			type: "event-observed",
			generationId: 7,
			eventId: 1,
			event: contentEvent("First "),
		});
		state = first.state;
		expect(first.effects).toEqual([
			{ kind: "story-content-delta", messageId: 907, variantId: 9_007, text: "First ", generationId: 7, eventId: 1 },
		]);
		expect(stateText(state, 7)?.lastEventId).toBe(1);
		expect(stateText(state, 8)?.lastEventId).toBe(0);
		expect(stateText(state, 8)?.phase).toBe("subscribing");

		const second = run(state, {
			type: "event-observed",
			generationId: 8,
			eventId: 1,
			event: contentEvent("Second "),
		});
		state = second.state;
		expect(second.effects).toEqual([
			{ kind: "story-content-delta", messageId: 908, variantId: 9_008, text: "Second ", generationId: 8, eventId: 1 },
		]);
		expect(stateText(state, 7)?.lastEventId).toBe(1);
		expect(stateText(state, 8)?.lastEventId).toBe(1);
	});

	test("Content and Reasoning Content produce separate story effects", () => {
		let state = sessionOf(42, targetsFor(7));

		const content = run(state, { type: "event-observed", generationId: 7, eventId: 1, event: contentEvent("Text") });
		state = content.state;
		expect(content.effects).toEqual([
			{ kind: "story-content-delta", messageId: 907, variantId: 9_007, text: "Text", generationId: 7, eventId: 1 },
		]);

		const reasoning = run(state, { type: "event-observed", generationId: 7, eventId: 2, event: reasoningEvent("Thought") });
		state = reasoning.state;
		expect(reasoning.effects).toEqual([
			{ kind: "story-reasoning-delta", messageId: 907, variantId: 9_007, text: "Thought", generationId: 7, eventId: 2 },
		]);

		const silent: GenerationEvent[] = [
			{ type: "usage", usage: { totalTokens: 9 } },
			{ type: "keepalive" },
			{ type: "finished", finishReason: "stop" },
		];
		let cursor = 2;
		for (const event of silent) {
			cursor += 1;
			const quiet = run(state, { type: "event-observed", generationId: 7, eventId: cursor, event });
			state = quiet.state;
			expect(quiet.effects).toEqual([]);
		}
		expect(stateText(state, 7)?.lastEventId).toBe(cursor);
	});

	test("duplicate and stale events are rejected without touching state", () => {
		let state = sessionOf(42, targetsFor(7));
		state = run(state, { type: "event-observed", generationId: 7, eventId: 3, event: contentEvent("Kept") }).state;

		const duplicate = run(state, { type: "event-observed", generationId: 7, eventId: 3, event: contentEvent("Dup") });
		const stale = run(state, { type: "event-observed", generationId: 7, eventId: 2, event: contentEvent("Stale") });
		expect(duplicate.state).toBe(state);
		expect(duplicate.effects).toEqual([]);
		expect(stale.state).toBe(state);
		expect(stale.effects).toEqual([]);
		expect(stateText(state, 7)?.lastEventId).toBe(3);
	});

	test("events for unknown Generations and after a Conversation switch are rejected", () => {
		const state = sessionOf(42, targetsFor(7));

		const unknown = run(state, { type: "event-observed", generationId: 99, eventId: 1, event: contentEvent("x") });
		expect(unknown.state).toBe(state);
		expect(unknown.effects).toEqual([]);

		const switched = run(state, { type: "conversation-switched" }).state;
		const late = run(switched, { type: "event-observed", generationId: 7, eventId: 1, event: contentEvent("x") });
		expect(late.state).toBe(switched);
		expect(late.effects).toEqual([]);
	});

	test("a detached session observes nothing; reattachment is reconciliation's job", () => {
		let state = sessionOf(42, targetsFor(7));
		state = run(state, {
			type: "subscription-settled",
			generationId: 7,
			result: { outcome: "interrupted", reason: "stream lost" },
		}).state;
		expect(stateText(state, 7)?.phase).toBe("detached");

		const lateEvent = run(state, { type: "event-observed", generationId: 7, eventId: 1, event: contentEvent("x") });
		const lateState = run(state, { type: "state-observed", generationId: 7, state: {
			outcome: "active-state",
			generationId: 7,
			conversationId: 42,
			messageId: 907,
			variantId: 9_007,
			content: "",
			reasoning: "",
			latestEventId: 1,
			status: "active",
			terminalReason: null,
		} });
		expect(lateEvent.state).toBe(state);
		expect(lateState.state).toBe(state);
		// Stop still works on a detached session: the Generation is alive.
		const stopped = run(state, { type: "stop-started", generationId: 7 });
		expect(stateText(stopped.state, 7)?.stopPending).toBe(true);
	});

	test("an authoritative state snapshot replaces story content and advances the cursor", () => {
		let state = sessionOf(42, targetsFor(7));

		const snapshot: GenerationStatePayload = {
			outcome: "active-state",
			generationId: 7,
			conversationId: 42,
			messageId: 907,
			variantId: 9_007,
			content: "Checkpointed.",
			reasoning: "Private.",
			latestEventId: 4,
			status: "active",
			terminalReason: null,
		};
		const applied = run(state, { type: "state-observed", generationId: 7, state: snapshot });
		state = applied.state;
		expect(applied.effects).toEqual([
			{ kind: "story-state", messageId: 907, variantId: 9_007, content: "Checkpointed.", reasoning: "Private.", generationId: 7, eventId: 4 },
		]);
		expect(stateText(state, 7)?.lastEventId).toBe(4);
		expect(stateText(state, 7)?.phase).toBe("observing");

		// The cursor moved, so a replayed frame below it is stale.
		const stale = run(state, { type: "event-observed", generationId: 7, eventId: 2, event: contentEvent("old") });
		expect(stale.state).toBe(state);
	});

	test("a terminal state snapshot settles the session and requests the authoritative refresh", () => {
		let state = sessionOf(42, targetsFor(7));

		const failed = {
			outcome: "active-state",
			generationId: 7,
			conversationId: 42,
			messageId: 907,
			variantId: 9_007,
			content: "Partial.",
			reasoning: "",
			latestEventId: 2,
			status: "failed",
			terminalReason: "The provider went quiet.",
		} as const;
		const settled = run(state, { type: "state-observed", generationId: 7, state: failed });
		state = settled.state;
		expect(stateText(state, 7)?.phase).toBe("terminal");
		expect(stateText(state, 7)?.terminal).toEqual({ outcome: "failed", reason: "The provider went quiet." });
		expect(firstActiveGenerationSessionFailure(state)?.reason ?? null).toBe("The provider went quiet.");
		expect(settled.effects.filter((effect) => effect.kind === "refresh-conversation")).toEqual([
			{ kind: "refresh-conversation", conversationId: 42 },
		]);
		expect(hasActiveGenerationSessions(state)).toBe(false);

		// A terminal session no longer accepts observations.
		const late = run(state, { type: "event-observed", generationId: 7, eventId: 3, event: contentEvent("x") });
		expect(late.state).toBe(state);
	});

	test("terminal stream results settle the session and request exactly one refresh", () => {
		// A `failed` result is not terminal here: it detaches and reconnects
		// (covered below); terminal failure arrives through the error frame or
		// an authoritative terminal snapshot.
		const cases: readonly { result: GenerationStreamResult; terminal: GenerationSessionTerminal | null }[] = [
			{ result: { outcome: "applied" }, terminal: { outcome: "applied" } },
			{ result: { outcome: "stopped", generationId: 7 }, terminal: { outcome: "stopped" } },
			{ result: { outcome: "not-found" }, terminal: { outcome: "not-found" } },
			// A server-declared failure settles the Generation: the provider (or
			// the lifecycle) reported why, and no reconnection may follow.
			{ result: { outcome: "failed", reason: "Provider broke." }, terminal: { outcome: "failed", reason: "Provider broke." } },
			{ result: { outcome: "not-playable", reason: "Not playable." }, terminal: { outcome: "failed", reason: "Not playable." } },
		];
		for (const example of cases) {
			let state = sessionOf(42, targetsFor(7));
			const settled = run(state, { type: "subscription-settled", generationId: 7, result: example.result });
			state = settled.state;
			expect(stateText(state, 7)?.terminal).toEqual(example.terminal);
			expect(stateText(state, 7)?.phase).toBe("terminal");
			expect(firstActiveGenerationSessionFailure(state)?.reason ?? null).toBe(
				example.terminal?.outcome === "failed" ? example.terminal.reason : null,
			);
			expect(settled.effects).toEqual([{ kind: "refresh-conversation", conversationId: 42 }]);
		}
	});

	test("offers the model a failed Generation sent Images to until the failure is acknowledged", () => {
		const imageModel = { connectionProfileId: 3, modelId: "vision-model" };
		const viaFrame = run(sessionOf(42, targetsFor(7)), {
			type: "subscription-settled",
			generationId: 7,
			result: { outcome: "failed", reason: "Images unsupported.", imageModel },
		}).state;
		const viaSnapshot = run(sessionOf(42, targetsFor(7)), {
			type: "state-observed",
			generationId: 7,
			state: {
				outcome: "active-state",
				generationId: 7,
				conversationId: 42,
				messageId: 907,
				variantId: 9_007,
				content: "",
				reasoning: "",
				latestEventId: 1,
				status: "failed",
				terminalReason: "Images unsupported.",
				imageModel,
			},
		}).state;

		for (const state of [viaFrame, viaSnapshot]) {
			expect(firstActiveGenerationSessionFailure(state)?.imageModel ?? null).toEqual(imageModel);
			expect(firstActiveGenerationSessionFailure(run(state, { type: "errors-acknowledged" }).state)?.imageModel ?? null).toBeNull();
		}
		const plain = run(sessionOf(42, targetsFor(7)), {
			type: "subscription-settled",
			generationId: 7,
			result: { outcome: "failed", reason: "Provider broke." },
		}).state;
		expect(firstActiveGenerationSessionFailure(plain)?.imageModel ?? null).toBeNull();
	});

	test("a terminal frame wins an in-flight Stop and retires stale Stop state", () => {
		let state = sessionOf(42, targetsFor(7));
		state = run(state, { type: "stop-started", generationId: 7 }).state;

		const terminalFrame = run(state, {
			type: "subscription-settled",
			generationId: 7,
			result: { outcome: "applied" },
		});
		state = terminalFrame.state;
		expect(stateText(state, 7)?.phase).toBe("terminal");
		expect(stateText(state, 7)?.stopPending).toBe(false);
		expect(hasPendingGenerationStop(state)).toBe(false);
		expect(firstActiveGenerationSessionFailure(state)?.reason ?? null).toBeNull();

		// The asynchronous Stop response is stale after the terminal frame and
		// must not reintroduce a Stop error on the terminal session.
		const lateStop = run(state, {
			type: "stop-settled",
			generationId: 7,
			outcome: { outcome: "failed", reason: "Generation already finished." },
		});
		expect(lateStop.state).toBe(state);
		expect(lateStop.effects).toEqual([]);
		expect(firstActiveGenerationSessionFailure(lateStop.state)?.reason ?? null).toBeNull();
	});

	test("a terminal state snapshot also retires an in-flight Stop", () => {
		let state = sessionOf(42, targetsFor(7));
		state = run(state, { type: "stop-started", generationId: 7 }).state;

		const terminalSnapshot = run(state, {
			type: "state-observed",
			generationId: 7,
			state: {
				outcome: "active-state",
				generationId: 7,
				conversationId: 42,
				messageId: 907,
				variantId: 9_007,
				content: "Complete.",
				reasoning: "",
				latestEventId: 2,
				status: "complete",
				terminalReason: null,
			},
		});
		expect(stateText(terminalSnapshot.state, 7)?.phase).toBe("terminal");
		expect(stateText(terminalSnapshot.state, 7)?.stopPending).toBe(false);
		expect(hasPendingGenerationStop(terminalSnapshot.state)).toBe(false);
		expect(terminalSnapshot.effects).toContainEqual({
			kind: "refresh-conversation",
			conversationId: 42,
		});
	});

	test("an interrupted subscription detaches with the error and reconnects from the latest processed event", () => {
		let state = sessionOf(42, targetsFor(7));
		for (let eventId = 1; eventId <= 3; eventId += 1) {
			state = run(state, {
				type: "event-observed",
				generationId: 7,
				eventId,
				event: contentEvent(`t${eventId}`),
			}).state;
		}

		const failed = run(state, {
			type: "subscription-settled",
			generationId: 7,
			result: { outcome: "interrupted", reason: "The stream ended." },
		});
		state = failed.state;
		expect(stateText(state, 7)?.phase).toBe("detached");
		expect(stateText(state, 7)?.error).toBe("The stream ended.");
		expect(stateText(state, 7)?.lastEventId).toBe(3);
		expect(firstActiveGenerationSessionFailure(state)?.reason ?? null).toBe("The stream ended.");
		expect(failed.effects).toEqual([{ kind: "refresh-conversation", conversationId: 42 }]);

		// Reconciliation while the server still lists the Generation resumes the
		// subscription after the latest processed event, never from event zero.
		const reattached = run(state, observed([7]));
		state = reattached.state;
		expect(reattached.effects).toEqual([
			{ kind: "subscribe", conversationId: 42, generationId: 7, messageId: 907, variantId: 9_007, afterEventId: 3 },
		]);
		expect(stateText(state, 7)?.phase).toBe("subscribing");
		expect(stateText(state, 7)?.lastEventId).toBe(3);
	});

	test("reconnection attempts are bounded and re-armed by observed liveness", () => {
		let state = sessionOf(42, targetsFor(7));
		for (let attempt = 0; attempt < MAX_SESSION_RECONNECTS; attempt += 1) {
			const failed = run(state, {
				type: "subscription-settled",
				generationId: 7,
				result: { outcome: "interrupted", reason: "down" },
			});
			state = failed.state;
			expect(failed.effects.map((effect) => effect.kind)).toEqual(["refresh-conversation"]);
			const reattached = run(state, observed([7]));
			state = reattached.state;
			expect(reattached.effects.map((effect) => effect.kind)).toEqual(
				attempt < MAX_SESSION_RECONNECTS - 1 ? ["subscribe"] : [],
			);
		}
		expect(stateText(state, 7)?.phase).toBe("detached");

		// Automatic reconnection stands down at the cap; navigation is the
		// user-paced escape hatch that re-arms the budget.
		state = run(state, { type: "conversation-switched" }).state;
		const rearmed = run(state, observed([7]));
		expect(rearmed.effects.map((effect) => effect.kind)).toEqual(["subscribe"]);
	});

	test("observing liveness clears a stale error", () => {
		let state = sessionOf(42, targetsFor(7));
		state = run(state, {
			type: "subscription-settled",
			generationId: 7,
			result: { outcome: "interrupted", reason: "blip" },
		}).state;
		state = run(state, observed([7])).state;
		state = run(state, { type: "event-observed", generationId: 7, eventId: 1, event: contentEvent("back") }).state;
		expect(stateText(state, 7)?.error).toBeNull();
		expect(firstActiveGenerationSessionFailure(state)?.reason ?? null).toBeNull();
	});

	test("Stop marks one session pending and its settled outcome keeps the stream or refreshes", () => {
		let state = sessionOf(42, targetsFor(7, 8));

		const started = run(state, { type: "stop-started", generationId: 7 });
		state = started.state;
		expect(stateText(state, 7)?.stopPending).toBe(true);
		expect(stateText(state, 8)?.stopPending).toBe(false);
		expect(hasPendingGenerationStop(state)).toBe(true);

		// While the stream is live, the server's stopped frame settles it; no
		// refresh is requested from the command outcome itself.
		const settledLive = run(state, {
			type: "stop-settled",
			generationId: 7,
			outcome: { outcome: "stopped" },
		});
		state = settledLive.state;
		expect(stateText(state, 7)?.stopPending).toBe(false);
		expect(settledLive.effects).toEqual([]);

		// A detached session receives no terminal frame, so the settled Stop
		// requests the authoritative refresh instead.
		state = run(state, {
			type: "subscription-settled",
			generationId: 8,
			result: { outcome: "interrupted", reason: "stream lost" },
		}).state;
		state = run(state, { type: "stop-started", generationId: 8 }).state;
		const settledDetached = run(state, {
			type: "stop-settled",
			generationId: 8,
			outcome: { outcome: "stopped" },
		});
		expect(settledDetached.effects).toEqual([{ kind: "refresh-conversation", conversationId: 42 }]);

		const failure = run(settledDetached.state, { type: "stop-started", generationId: 7 }).state;
		const failedStop = run(failure, {
			type: "stop-settled",
			generationId: 7,
			outcome: { outcome: "failed", reason: "Unreachable." },
		});
		expect(stateText(failedStop.state, 7)?.error).toBe("Unreachable.");
	});

	test("Stop All applies across the collection", () => {
		let state = sessionOf(42, targetsFor(7, 8));

		const started = run(state, { type: "stop-all-started" });
		state = started.state;
		expect(stateText(state, 7)?.stopPending).toBe(true);
		expect(stateText(state, 8)?.stopPending).toBe(true);

		const settled = run(state, { type: "stop-all-settled", outcome: { outcome: "stopped" } });
		state = settled.state;
		expect(stateText(state, 7)?.stopPending).toBe(false);
		expect(stateText(state, 8)?.stopPending).toBe(false);
		expect(settled.effects).toEqual([]);

		// With only one active session Stop All is refused.
		const single = sessionOf(42, targetsFor(7));
		const refused = run(single, { type: "stop-all-started" });
		expect(refused.state).toBe(single);
		expect(refused.effects).toEqual([]);
	});

	test("a failed Stop All records the reason on every pending session", () => {
		let state = sessionOf(42, targetsFor(7, 8));
		state = run(state, { type: "stop-all-started" }).state;
		const failed = run(state, {
			type: "stop-all-settled",
			outcome: { outcome: "failed", reason: "Generations could not be stopped." },
		});
		state = failed.state;
		expect(stateText(state, 7)?.error).toBe("Generations could not be stopped.");
		expect(stateText(state, 8)?.error).toBe("Generations could not be stopped.");
		expect(stateText(state, 7)?.stopPending).toBe(false);
		expect(firstActiveGenerationSessionFailure(state)?.reason ?? null).toBe("Generations could not be stopped.");
	});

	test("a Conversation switch detaches local subscriptions but keeps cursors for the return", () => {
		let state = sessionOf(42, targetsFor(7, 8));
		state = run(state, { type: "event-observed", generationId: 7, eventId: 5, event: contentEvent("kept") }).state;

		const switched = run(state, { type: "conversation-switched" });
		state = switched.state;
		// Only the local subscriptions close; no stop command exists in the
		// effect vocabulary, so navigation can never cancel server work.
		expect(switched.effects).toEqual([
			{ kind: "unsubscribe", generationId: 7 },
			{ kind: "unsubscribe", generationId: 8 },
		]);
		expect(state.activeConversationId).toBeNull();
		expect(stateText(state, 7)?.phase).toBe("detached");
		expect(stateText(state, 7)?.lastEventId).toBe(5);
		expect(stateText(state, 8)?.phase).toBe("detached");
		expect(hasActiveGenerationSessions(state)).toBe(false);

		// Returning reattaches from each Generation's own cursor.
		const returned = run(state, observed([7, 8]));
		expect(returned.effects).toEqual([
			{ kind: "subscribe", conversationId: 42, generationId: 7, messageId: 907, variantId: 9_007, afterEventId: 5 },
			{ kind: "subscribe", conversationId: 42, generationId: 8, messageId: 908, variantId: 9_008, afterEventId: 0 },
		]);
	});

	test.each(["failed", "applied", "stopped"] as const)("a live session missing from a refreshed snapshot still observes its %s terminal outcome", (outcome) => {
		const accepted = run(createGenerationSessions(), { type: "generation-accepted", target: { ...target(7), conversationId: 42 } });
		const refreshed = run(accepted.state, observed([]));
		expect(refreshed.state.sessions.has(7)).toBe(true);
		expect(refreshed.effects).toEqual([]);
		const result = outcome === "failed" ? { outcome, reason: "The provider request failed with HTTP 401." } : { outcome };
		const settled = run(refreshed.state, { type: "subscription-settled", generationId: 7, result });
		expect(hasActiveGenerationSessions(settled.state)).toBe(false);
		expect(firstActiveGenerationSessionFailure(settled.state)?.reason ?? null).toBe(outcome === "failed" ? "The provider request failed with HTTP 401." : null);
		expect(run(settled.state, { type: "subscription-settled", generationId: 7, result }).state).toBe(settled.state);
		expect(run(settled.state, { type: "errors-acknowledged" }).state.sessions.get(7)?.error).toBeNull();
	});

	test("a Conversation switch drops terminal sessions and sessions the server settled elsewhere", () => {
		let state = sessionOf(42, targetsFor(7, 8, 9));
		state = run(state, { type: "subscription-settled", generationId: 7, result: { outcome: "applied" } }).state;
		state = run(state, { type: "subscription-settled", generationId: 9, result: { outcome: "interrupted", reason: "Server restarted." } }).state;
		// Generation 9's disconnected subscription cannot supply a terminal result.
		state = run(state, observed([7, 8])).state;
		expect(state.sessions.has(9)).toBe(false);

		const switched = run(state, { type: "conversation-switched" });
		expect(switched.effects).toEqual([{ kind: "unsubscribe", generationId: 8 }]);
		expect(switched.state.sessions.has(7)).toBe(false);
		expect(switched.state.sessions.has(8)).toBe(true);
	});

	test("completion order never reorders sibling Variants", () => {
		// Two Sibling Generations of one Message; the machine addresses every
		// story effect by Variant id only, so completion order cannot influence
		// Variant positions.
		const siblingA = target(7, { messageId: 500, variantId: 6_001 });
		const siblingB = target(8, { messageId: 500, variantId: 6_002 });
		let state = sessionOf(42, [siblingA, siblingB]);
		const firstDelta = run(state, { type: "event-observed", generationId: 8, eventId: 1, event: contentEvent("Second accepted, first done") });
		state = firstDelta.state;
		const settledFirst = run(state, { type: "subscription-settled", generationId: 8, result: { outcome: "applied" } });
		state = settledFirst.state;
		const secondDelta = run(state, { type: "event-observed", generationId: 7, eventId: 1, event: contentEvent("First accepted, second done") });
		state = secondDelta.state;
		const settledSecond = run(state, { type: "subscription-settled", generationId: 7, result: { outcome: "applied" } });

		const storyTargets = [
			...firstDelta.effects,
			...settledFirst.effects,
			...secondDelta.effects,
			...settledSecond.effects,
		].filter((effect): effect is Extract<GenerationSessionEffect, { kind: "story-content-delta" | "story-state" }> =>
			effect.kind === "story-content-delta" || effect.kind === "story-state");
		// Every story effect is addressed by Variant id; terminal completion
		// contributes no story effect at all, so completion order cannot
		// influence Variant positions (those stay server-owned).
		expect(storyTargets).toEqual([
			{ kind: "story-content-delta", messageId: 500, variantId: 6_002, text: "Second accepted, first done", generationId: 8, eventId: 1 },
			{ kind: "story-content-delta", messageId: 500, variantId: 6_001, text: "First accepted, second done", generationId: 7, eventId: 1 },
		]);
	});

	test("state snapshots with any mismatched target identity are rejected", () => {
		const state = sessionOf(42, targetsFor(7));
		const matching = {
			outcome: "active-state",
			generationId: 7,
			conversationId: 42,
			messageId: 907,
			variantId: 9_007,
			content: "x",
			reasoning: "",
			latestEventId: 1,
			status: "active",
			terminalReason: null,
		} as const;
		const foreignStates = [
			{ ...matching, conversationId: 43 },
			{ ...matching, generationId: 8 },
			{ ...matching, messageId: 908 },
			{ ...matching, variantId: 9_008 },
		];
		for (const foreign of foreignStates) {
			const rejected = run(state, { type: "state-observed", generationId: 7, state: foreign });
			expect(rejected.state).toBe(state);
			expect(rejected.effects).toEqual([]);
		}
	});

	test("acknowledged errors clear every session error", () => {
		let state = sessionOf(42, targetsFor(7));
		state = run(state, {
			type: "subscription-settled",
			generationId: 7,
			result: { outcome: "interrupted", reason: "blip" },
		}).state;
		state = run(state, { type: "errors-acknowledged" }).state;
		expect(stateText(state, 7)?.error).toBeNull();
		expect(firstActiveGenerationSessionFailure(state)?.reason ?? null).toBeNull();
	});

	test("a duplicate settle after a switch or terminal is rejected", () => {
		let state = sessionOf(42, targetsFor(7));
		state = run(state, { type: "subscription-settled", generationId: 7, result: { outcome: "applied" } }).state;
		const again = run(state, { type: "subscription-settled", generationId: 7, result: { outcome: "applied" } });
		expect(again.state).toBe(state);
		expect(again.effects).toEqual([]);
	});
});
