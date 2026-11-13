import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { GenerationEvent, GenerationStatePayload } from "../shared/contract/generation-events";
import type {
	GenerationStreamAdapter,
	GenerationStreamResult,
	GenerationStreamSubscription,
} from "./conversation-stream";
import { createGenerationSessionRunner } from "./generation-session-runner";
import { createVariantStreams } from "./story/variant-streams";
import { NetworkError } from "./lib/request-outcome";
import { hasActiveGenerationSessions } from "./generation-sessions";
import type {
	GenerationSessionsState,
	GenerationSessionTarget,
} from "./generation-sessions";

// Thin integration tests for the session runner: a fake stream adapter
// satisfies the same session interface as the production SSE adapter, and
// the tests verify the wiring between machine transitions and executed
// effects — subscriptions, aborts, story effects, and refresh requests —
// without React or a network.

const target = (generationId: number): GenerationSessionTarget => ({
	generationId,
	messageId: 900 + generationId,
	variantId: 9_000 + generationId,
});

const contentEvent = (text: string): GenerationEvent => ({ type: "content", text });

const stateSnapshot = (overrides: Partial<Pick<GenerationStatePayload, "content" | "reasoning" | "latestEventId">>): GenerationStatePayload => ({
	outcome: "active-state",
	generationId: 7,
	conversationId: 42,
	messageId: 907,
	variantId: 9_007,
	content: "",
	reasoning: "",
	latestEventId: 0,
	status: "active",
	...overrides,
});

interface FakeStream {
	adapter: GenerationStreamAdapter;
	requests: GenerationStreamSubscription[];
	settle: (index: number, result: GenerationStreamResult) => void;
	reject: (index: number) => void;
}

// A fake adapter that records every subscription request and holds its
// settlement handles, so tests control exactly what the stream reports.
const fakeStream = (): FakeStream => {
	const requests: GenerationStreamSubscription[] = [];
	const pending: {
		resolve: (result: GenerationStreamResult) => void;
		reject: (error: Error) => void;
	}[] = [];
	return {
		requests,
		adapter: {
			subscribe: (request) =>
				new Promise<GenerationStreamResult>((resolve, reject) => {
					requests.push(request);
					pending.push({ resolve, reject });
				}),
		},
		settle: (index, result) => pending[index]!.resolve(result),
		reject: (index) => pending[index]!.reject(new Error("stream failed")),
	};
};

interface Host {
	streams: ReturnType<typeof createVariantStreams>;
	refreshes: number[];
}

const host = (): Host => ({
	streams: createVariantStreams(),
	refreshes: [],
});

// Lets the runner's promise reactions settle before assertions; setImmediate stays real under fake timers.
const flushSubscriptions = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// Fires each retry timer as soon as the previous attempt has failed, until `done` settles.
const retryUntil = async (done: Promise<void>): Promise<void> => {
	let settled = false;
	void done.then(() => { settled = true; });
	while (!settled) {
		await flushSubscriptions();
		jest.advanceTimersToNextTimer();
	}
};

const runnerWith = (stream: FakeStream, spy: Host) =>
	createGenerationSessionRunner({
		adapter: stream.adapter,
		streams: spy.streams,
		getVariant: () => undefined,
		refreshConversation: async (conversationId) => { spy.refreshes.push(conversationId); },
	});

const observeTargets = (generationIds: readonly number[]) =>
	({ type: "targets-observed", conversationId: 42, targets: generationIds.map(target) }) as const;

describe("the Generation session runner", () => {
	beforeEach(() => { jest.useFakeTimers(); });
	afterEach(() => { jest.useRealTimers(); });

	test("retries transport failures until an authoritative snapshot settles the detached Generation", async () => {
		const stream = fakeStream();
		let attempts = 0;
		const recovered = Promise.withResolvers<void>();
		const runner = createGenerationSessionRunner({
			adapter: stream.adapter,
			streams: createVariantStreams(),
			getVariant: () => undefined,
			refreshConversation: async () => {
				if (++attempts < 3) throw new NetworkError("Server is down");
				runner.dispatch(observeTargets([]));
				recovered.resolve();
			},
		});
		runner.dispatch(observeTargets([7]));
		stream.settle(0, { outcome: "interrupted", reason: "Server restarted" });
		await retryUntil(recovered.promise);
		expect(attempts).toBe(3);
		expect(runner.getSnapshot().sessions.has(7)).toBe(false);
		expect(stream.requests).toHaveLength(1);
		runner.dispose();
	});

	test("a recovered active snapshot resumes the saved event cursor", async () => {
		const stream = fakeStream();
		let attempts = 0;
		const recovered = Promise.withResolvers<void>();
		const runner = createGenerationSessionRunner({
			adapter: stream.adapter,
			streams: createVariantStreams(),
			getVariant: () => undefined,
			refreshConversation: async () => {
				if (++attempts === 1) throw new NetworkError("Server is down");
				runner.dispatch(observeTargets([7]));
				recovered.resolve();
			},
		});
		runner.dispatch(observeTargets([7]));
		stream.requests[0]!.onEvent({ eventId: 12, event: contentEvent("Saved") });
		stream.settle(0, { outcome: "interrupted", reason: "Disconnected" });
		await retryUntil(recovered.promise);
		expect(stream.requests).toHaveLength(2);
		expect(stream.requests[1]!.afterEventId).toBe(12);
		runner.dispose();
	});

	for (const action of ["switch", "implicit-switch", "dispose"] as const) {
		test(`${action} cancels a pending refresh and its retries`, async () => {
			const stream = fakeStream();
			let attempts = 0;
			let refreshSignal: AbortSignal | undefined;
			const runner = createGenerationSessionRunner({
				adapter: stream.adapter,
				streams: createVariantStreams(),
				getVariant: () => undefined,
				refreshConversation: async (_conversationId, signal) => {
					attempts++;
					refreshSignal = signal;
					throw new NetworkError("Server is down");
				},
			});
			runner.dispatch(observeTargets([7]));
			stream.settle(0, { outcome: "interrupted", reason: "Disconnected" });
			await flushSubscriptions();
			if (action === "dispose") runner.dispose();
			else if (action === "switch") runner.dispatch({ type: "conversation-switched" });
			else runner.dispatch({ type: "targets-observed", conversationId: 43, targets: [] });
			jest.advanceTimersByTime(2_000);
			expect(refreshSignal?.aborted).toBe(true);
			expect(attempts).toBe(1);
			runner.dispose();
		});
	}

	test("an application refresh failure cannot strand an interrupted Generation", async () => {
		const stream = fakeStream();
		let attempts = 0;
		const runner = createGenerationSessionRunner({
			adapter: stream.adapter,
			streams: createVariantStreams(),
			getVariant: () => undefined,
			refreshConversation: async () => {
				if (++attempts === 1) throw new Error("Invalid Conversation response");
				runner.dispatch(observeTargets([]));
			},
		});
		try {
			runner.dispatch(observeTargets([7]));
			stream.settle(0, { outcome: "interrupted", reason: "Disconnected" });
			await flushSubscriptions();
			jest.advanceTimersByTime(250);
			await flushSubscriptions();
			expect(hasActiveGenerationSessions(runner.getSnapshot())).toBe(false);
			expect(attempts).toBe(2);
		} finally { runner.dispose(); }
	});

	test("opens subscriptions through the adapter and routes observations to Variant streams", () => {
		const stream = fakeStream();
		const spy = host();
		const runner = runnerWith(stream, spy);

		runner.dispatch(observeTargets([7]));

		expect(stream.requests).toHaveLength(1);
		expect(stream.requests[0]?.conversationId).toBe(42);
		expect(stream.requests[0]?.generationId).toBe(7);
		expect(stream.requests[0]?.afterEventId).toBe(0);
		expect(runner.getSnapshot().sessions.has(7)).toBe(true);

		stream.requests[0]!.onEvent({ eventId: 1, event: contentEvent("Hello") });
		stream.requests[0]!.onEvent({ eventId: 2, event: { type: "reasoning", text: "Plan" } });
		// Reject routing Content and Reasoning into different Variants or dropping either stream.
		expect(spy.streams.get(9_007)).toEqual({ generationId: 7, eventId: 2, content: "Hello", reasoning: "Plan" });

		stream.requests[0]!.onState(stateSnapshot({
			content: "Checkpoint",
			reasoning: "Revised plan",
			latestEventId: 3,
		}));
		// Reject treating a state snapshot as an append or leaving its Reasoning stale.
		expect(spy.streams.get(9_007)).toEqual({ generationId: 7, eventId: 3, content: "Checkpoint", reasoning: "Revised plan" });
	});

	test("a refresh that has not placed an accepted Generation cannot discard its stream", () => {
		const stream = fakeStream();
		const spy = host();
		const runner = runnerWith(stream, spy);
		runner.dispatch(observeTargets([]));
		runner.dispatch({ type: "generation-accepted", target: { ...target(7), conversationId: 42 } });
		stream.requests[0]!.onEvent({ eventId: 1, event: contentEvent("One.") });
		runner.dispatch(observeTargets([]));
		stream.requests[0]!.onEvent({ eventId: 2, event: contentEvent(" Two.") });
		// Reject treating an absent target as terminal while its live session can still deliver text.
		expect(spy.streams.get(9_007)?.content).toBe("One. Two.");
		runner.dispose();
	});

	test("a checkpoint observed before the first subscription survives an off-window delta", () => {
		const stream = fakeStream();
		const spy = host();
		const runner = runnerWith(stream, spy);
		spy.streams.checkpoint([{ id: 9_007, position: 1, content: "One. Two.", reasoning: "", empty: false, hasReasoning: false, generationId: 7, lastEventId: 2 }]);
		runner.dispatch({ type: "targets-observed", conversationId: 42, targets: [{ ...target(7), initialEventId: 2 }] });
		stream.requests[0]!.onEvent({ eventId: 3, event: contentEvent(" Three.") });
		// Reject collecting the new Chat's checkpoint along with the previous Chat's streams.
		expect(spy.streams.get(9_007)?.content).toBe("One. Two. Three.");
		runner.dispose();
	});

	for (const end of ["applied", "stopped", "not-found", "failed", "snapshot", "deleted", "switch", "implicit-switch", "dispose"] as const) {
		test(`${end} releases accumulated Variant text`, async () => {
			const stream = fakeStream();
			const spy = host();
			const runner = runnerWith(stream, spy);
			runner.dispatch(observeTargets([7, 8]));
			stream.requests[0]!.onEvent({ eventId: 1, event: contentEvent("Finished text") });
			stream.requests[1]!.onEvent({ eventId: 1, event: contentEvent("Still generating") });
			if (end === "dispose") runner.dispose();
			else if (end === "switch") runner.dispatch({ type: "conversation-switched" });
			else if (end === "implicit-switch") runner.dispatch({ type: "targets-observed", conversationId: 43, targets: [] });
			else if (end === "deleted") {
				stream.settle(0, { outcome: "interrupted", reason: "Disconnected before deletion" });
				await flushSubscriptions();
				runner.dispatch(observeTargets([8]));
			} else if (end === "snapshot") stream.requests[0]!.onState({ ...stateSnapshot({ content: "Final", latestEventId: 2 }), status: "complete" });
			else {
				stream.settle(0, end === "failed" ? { outcome: end, reason: "Provider failed" } : { outcome: end });
			}
			await flushSubscriptions();
			// Reject keeping completed, deleted, or abandoned Chat text for the workspace lifetime.
			expect(spy.streams.get(9_007)).toBeUndefined();
			if (!["switch", "implicit-switch", "dispose"].includes(end)) {
				// Reject collecting another active Generation just because it has no mounted Message.
				expect(spy.streams.get(9_008)?.content).toBe("Still generating");
			}
			runner.dispose();
		});
	}

	for (const implicit of [false, true]) test(`returning after an ${implicit ? "implicit" : "explicit"} Chat switch replays discarded text`, () => {
		const stream = fakeStream();
		const spy = host();
		const runner = runnerWith(stream, spy);
		runner.dispatch(observeTargets([7]));
		stream.requests[0]!.onEvent({ eventId: 1, event: contentEvent("One.") });
		if (implicit) runner.dispatch({ type: "targets-observed", conversationId: 43, targets: [] });
		else runner.dispatch({ type: "conversation-switched" });
		runner.dispatch(observeTargets([7]));
		// Reject reusing a cursor after its accumulated text was discarded.
		expect(stream.requests[1]?.afterEventId).toBe(0);
		stream.requests[1]!.onEvent({ eventId: 1, event: contentEvent("One.") });
		stream.requests[1]!.onEvent({ eventId: 2, event: contentEvent(" Two.") });
		// Reject suppressing replay at the session cursor even if transport requested it correctly.
		expect(spy.streams.get(9_007)?.content).toBe("One. Two.");
		runner.dispose();
	});

	test("a terminal settle requests the authoritative refresh for the active Conversation", async () => {
		const stream = fakeStream();
		const spy = host();
		const runner = runnerWith(stream, spy);

		runner.dispatch(observeTargets([7]));
		expect(spy.refreshes).toEqual([]);

		stream.requests[0]!.onEvent({ eventId: 1, event: contentEvent("A") });
		stream.settle(0, { outcome: "applied" });
		await flushSubscriptions();

		expect(spy.refreshes).toEqual([42]);
	});

	test("a failed settle refreshes, and the next reconciliation resubscribes from the cursor", async () => {
		const stream = fakeStream();
		const spy = host();
		const runner = runnerWith(stream, spy);

		runner.dispatch(observeTargets([7]));
		stream.requests[0]!.onEvent({ eventId: 1, event: contentEvent("A") });
		stream.requests[0]!.onEvent({ eventId: 2, event: contentEvent("B") });
		stream.settle(0, { outcome: "interrupted", reason: "The stream ended." });
		await flushSubscriptions();

		expect(spy.refreshes).toEqual([42]);

		runner.dispatch(observeTargets([7]));
		expect(stream.requests).toHaveLength(2);
		expect(stream.requests[1]?.afterEventId).toBe(2);
	});

	test("a rejected subscription reports the interruption through the machine", async () => {
		const stream = fakeStream();
		const spy = host();
		const runner = runnerWith(stream, spy);

		runner.dispatch(observeTargets([7]));
		stream.reject(0);
		await flushSubscriptions();

		expect(spy.refreshes).toEqual([42]);
		expect(firstSessionError(runner.getSnapshot())).toBe("Generation subscription was interrupted.");
	});

	test("a Conversation switch aborts only the local subscription and swallows the aborted settle", async () => {
		const stream = fakeStream();
		const spy = host();
		const runner = runnerWith(stream, spy);

		runner.dispatch(observeTargets([7]));
		runner.dispatch({ type: "conversation-switched" });

		expect(stream.requests[0]!.signal.aborted).toBe(true);
		expect(spy.refreshes).toEqual([]);

		// The late settle of the aborted local subscription must not refresh or
		// resurrect the detached session.
		stream.settle(0, { outcome: "applied" });
		await flushSubscriptions();
		expect(spy.refreshes).toEqual([]);
		expect(runner.getSnapshot().sessions.get(7)?.phase).toBe("detached");
	});

	test("dispose aborts every live subscription", () => {
		const stream = fakeStream();
		const spy = host();
		const runner = runnerWith(stream, spy);

		runner.dispatch(observeTargets([7, 8]));
		runner.dispose();

		expect(stream.requests[0]!.signal.aborted).toBe(true);
		expect(stream.requests[1]!.signal.aborted).toBe(true);
	});

	test("snapshot identity is stable without transitions and changes after a meaningful transition", () => {
		const stream = fakeStream();
		const spy = host();
		const runner = runnerWith(stream, spy);

		const initial = runner.getSnapshot();
		runner.dispatch(observeTargets([]));
		const empty = runner.getSnapshot();
		expect(empty).not.toBe(initial);
		expect(empty.activeConversationId).toBe(42);

		runner.dispatch(observeTargets([]));
		expect(runner.getSnapshot()).toBe(empty);

		runner.dispatch(observeTargets([7]));
		const reconciled = runner.getSnapshot();
		expect(reconciled).not.toBe(empty);
		expect(reconciled.sessions.has(7)).toBe(true);

		runner.dispatch(observeTargets([7]));
		expect(runner.getSnapshot()).toBe(reconciled);
	});

	test("subscribers are notified on transitions and can unsubscribe", () => {
		const stream = fakeStream();
		const spy = host();
		const runner = runnerWith(stream, spy);

		let notifications = 0;
		const unsubscribe = runner.subscribe(() => {
			notifications += 1;
		});

		runner.dispatch(observeTargets([7]));
		expect(notifications).toBe(1);

		runner.dispatch(observeTargets([7]));
		expect(notifications).toBe(1);

		unsubscribe();
		runner.dispatch(observeTargets([8]));
		expect(notifications).toBe(1);
		expect(runner.getSnapshot().sessions.has(8)).toBe(true);
	});

	test("disposal stops subscriber updates including late settles", async () => {
		const stream = fakeStream();
		const spy = host();
		const runner = runnerWith(stream, spy);

		let notifications = 0;
		runner.subscribe(() => {
			notifications += 1;
		});

		runner.dispatch(observeTargets([7]));
		expect(notifications).toBe(1);

		runner.dispose();
		const detached = runner.getSnapshot();
		expect(detached.sessions.get(7)?.phase).toBe("detached");

		runner.dispatch(observeTargets([8]));
		expect(notifications).toBe(1);
		expect(runner.getSnapshot()).toBe(detached);

		stream.settle(0, { outcome: "applied" });
		await flushSubscriptions();
		expect(notifications).toBe(1);
		expect(spy.refreshes).toEqual([]);
	});
});

function firstSessionError(state: GenerationSessionsState): string | null {
	for (const session of state.sessions.values()) {
		if (session.error !== null) return session.error;
	}
	return null;
}
