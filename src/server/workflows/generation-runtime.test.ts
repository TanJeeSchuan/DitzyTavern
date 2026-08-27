import { describe, expect, test } from "bun:test";
import { GenerationRuntimeRegistry } from "./generation-runtime";

describe("Generation runtime", () => {
	test("fans one ordered provider stream out to multiple subscribers", () => {
		const registry = new GenerationRuntimeRegistry();
		const runtime = registry.start({
			generationId: 7,
			conversationId: 3,
			messageId: 12,
			variantId: 18,
			startedAt: "2026-08-27T00:00:00.000Z",
		});
		const first: number[] = [];
		const second: number[] = [];
		runtime.subscribe(0, (event) => first.push(event.eventId));
		runtime.publish({ type: "content", text: "one" });
		runtime.publish({ type: "content", text: "two" });
		runtime.subscribe(1, (event) => second.push(event.eventId));
		runtime.publish({ type: "finished", finishReason: "stop" });

		expect(first).toEqual([1, 2, 3]);
		expect(second).toEqual([2, 3]);
		expect(runtime.state.content).toBe("onetwo");
		expect(runtime.state.latestEventId).toBe(3);
	});

	test("sends authoritative state when the requested replay position expired", () => {
		const registry = new GenerationRuntimeRegistry();
		const runtime = registry.start({
			generationId: 8,
			conversationId: 3,
			messageId: 12,
			variantId: 18,
			startedAt: "2026-08-27T00:00:00.000Z",
		});
		const originalLimit = GenerationRuntimeRegistry.MAX_RETAINED_EVENTS;
		// Keep the production bound untouched; publishing more than the bound
		// still exercises the exact unavailable-replay branch.
		for (let index = 0; index < originalLimit + 3; index += 1) {
			runtime.publish({ type: "content", text: "x" });
		}
		const states: string[] = [];
		const events: number[] = [];
		const subscription = runtime.subscribe(1, (event) => events.push(event.eventId), (state) => states.push(state.content));
		expect(subscription.replayAvailable).toBe(false);
		expect(states).toEqual(["x".repeat(originalLimit + 3)]);
		expect(events).toEqual([]);
	});

	test("a disconnected subscriber does not abort the provider-owned signal", () => {
		const registry = new GenerationRuntimeRegistry();
		const runtime = registry.start({
			generationId: 9,
			conversationId: 3,
			messageId: 12,
			variantId: 18,
			startedAt: "2026-08-27T00:00:00.000Z",
		});
		const subscription = runtime.subscribe(0, () => {});
		subscription.close();
		expect(runtime.signal.aborted).toBe(false);
		runtime.publish({ type: "content", text: "still running" });
		expect(runtime.state.content).toBe("still running");
	});

	test("checkpoints visible streams at a bounded cadence and can be flushed deterministically", () => {
		const checkpoints: Array<{ content: string; reasoning: string; latestEventId: number }> = [];
		const runtime = new GenerationRuntimeRegistry().start({
			generationId: 10,
			conversationId: 3,
			messageId: 12,
			variantId: 18,
			startedAt: "2026-08-27T00:00:00.000Z",
			checkpoint: { eventInterval: 2, intervalMs: 0 },
			onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
		});
		runtime.publish({ type: "content", text: "one" });
		runtime.publish({ type: "reasoning", text: "think" });
		expect(checkpoints).toEqual([{ content: "one", reasoning: "think", latestEventId: 2 }]);
		runtime.publish({ type: "content", text: "two" });
		runtime.flushCheckpoint();
		expect(checkpoints.at(-1)).toEqual({ content: "onetwo", reasoning: "think", latestEventId: 3 });
	});
});
