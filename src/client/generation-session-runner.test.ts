import { describe, expect, test } from "bun:test";
import type { GenerationEvent, GenerationStatePayload } from "../shared/contract/generation-events";
import type {
	GenerationStreamAdapter,
	GenerationStreamResult,
	GenerationStreamSubscription,
} from "./conversation-stream";
import { createGenerationSessionRunner } from "./generation-session-runner";
import type {
	GenerationSessionStoryEffect,
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

const stateSnapshot = (overrides: Partial<GenerationStatePayload>): GenerationStatePayload => ({
	outcome: "active-state",
	generationId: 7,
	conversationId: 42,
	messageId: 907,
	variantId: 9_007,
	content: "",
	reasoning: "",
	latestEventId: 0,
	status: "active",
	terminalReason: null,
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
	storyEffects: GenerationSessionStoryEffect[];
	refreshes: number[];
	states: GenerationSessionsState[];
}

const host = (): Host => ({
	storyEffects: [],
	refreshes: [],
	states: [],
});

// Lets the runner's promise reactions settle before assertions.
const flushSubscriptions = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const runnerWith = (stream: FakeStream, spy: Host) =>
	createGenerationSessionRunner({
		adapter: stream.adapter,
		applyStoryEffect: (effect) => spy.storyEffects.push(effect),
		refreshConversation: (conversationId) => spy.refreshes.push(conversationId),
		onStateChange: (state) => spy.states.push(state),
	});

const observeTargets = (generationIds: readonly number[]) =>
	({ type: "targets-observed", conversationId: 42, targets: generationIds.map(target) }) as const;

describe("the Generation session runner", () => {
	test("opens subscriptions through the adapter and routes observations to story effects", () => {
		const stream = fakeStream();
		const spy = host();
		const runner = runnerWith(stream, spy);

		runner.dispatch(observeTargets([7]));

		expect(stream.requests).toHaveLength(1);
		expect(stream.requests[0]?.conversationId).toBe(42);
		expect(stream.requests[0]?.generationId).toBe(7);
		expect(stream.requests[0]?.afterEventId).toBe(0);
		expect(spy.states).toHaveLength(1);

		stream.requests[0]!.onEvent({ eventId: 1, event: contentEvent("Hello") });
		stream.requests[0]!.onEvent({ eventId: 2, event: { type: "reasoning", text: "Plan" } });
		expect(spy.storyEffects).toEqual([
			{ kind: "story-content-delta", messageId: 907, variantId: 9_007, text: "Hello" },
			{ kind: "story-reasoning-delta", messageId: 907, variantId: 9_007, text: "Plan" },
		]);

		stream.requests[0]!.onState(stateSnapshot({
			content: "Hello",
			reasoning: "Plan",
			latestEventId: 2,
		}));
		expect(spy.storyEffects.slice(2)).toEqual([
			{ kind: "story-content-replace", messageId: 907, variantId: 9_007, content: "Hello" },
			{ kind: "story-reasoning-replace", messageId: 907, variantId: 9_007, reasoning: "Plan" },
		]);
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
		expect(firstSessionError(runner.snapshot())).toBe("Generation subscription was interrupted.");
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
		expect(runner.snapshot().sessions.get(7)?.phase).toBe("detached");
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
});

function firstSessionError(state: GenerationSessionsState): string | null {
	for (const session of state.sessions.values()) {
		if (session.error !== null) return session.error;
	}
	return null;
}
