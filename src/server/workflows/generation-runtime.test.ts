import { describe, expect, test } from "bun:test";
import { openDatabase } from "../database/database";
import { gracefullyShutdownGenerations } from "./generation-recovery";
import {
	defaultGenerationRuntime,
	generationRuntimeFor,
	GenerationRuntimeRegistry,
} from "./generation-runtime";

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

	test("expires terminal replay state on the scheduled boundary while the process is idle", () => {
		let now = 1_000;
		let scheduled: (() => void) | undefined;
		let delay = -1;
		let expired = 0;
		const registry = new GenerationRuntimeRegistry({
			now: () => now,
			schedule: (callback, delayMs) => {
				scheduled = callback;
				delay = delayMs;
				return { cancel: () => {} };
			},
			cancel: () => {},
		});
		const runtime = registry.start({
			generationId: 12,
			conversationId: 3,
			messageId: 12,
			variantId: 18,
			startedAt: "2026-08-27T00:00:00.000Z",
			checkpoint: { now: () => now },
			onRetentionExpired: () => { expired += 1; },
		});
		runtime.complete();

		expect(delay).toBe(GenerationRuntimeRegistry.TERMINAL_REPLAY_RETENTION_MS);
		expect(scheduled).toBeDefined();
		now += GenerationRuntimeRegistry.TERMINAL_REPLAY_RETENTION_MS;
		scheduled?.();

		expect(expired).toBe(1);
		expect(registry.get(12)).toBeUndefined();
	});

	test("complete and failed terminals flush sub-cadence output first", () => {
		for (const terminal of ["complete", "failed"] as const) {
			const checkpoints: Array<{ reasoning: string; latestEventId: number }> = [];
			const runtime = new GenerationRuntimeRegistry().start({
				generationId: terminal === "complete" ? 13 : 14,
				conversationId: 3,
				messageId: 12,
				variantId: 18,
				startedAt: "2026-08-27T00:00:00.000Z",
				checkpoint: { eventInterval: 99, intervalMs: 0 },
				onCheckpoint: ({ reasoning, latestEventId }) => checkpoints.push({ reasoning, latestEventId }),
			});
			runtime.publish({ type: "reasoning", text: "final thought" });
			if (terminal === "complete") runtime.complete();
			else runtime.fail("provider disconnected");

			expect(checkpoints).toEqual([{
				reasoning: "final thought",
				latestEventId: terminal === "complete" ? 1 : 2,
			}]);
		}
	});

	test("stop flushes the latest output, aborts the provider, and wins a terminal race", () => {
		const checkpoints: Array<{ content: string; reasoning: string; latestEventId: number }> = [];
		const runtime = new GenerationRuntimeRegistry().start({
			generationId: 11,
			conversationId: 3,
			messageId: 12,
			variantId: 18,
			startedAt: "2026-08-27T00:00:00.000Z",
			checkpoint: { eventInterval: 99, intervalMs: 0 },
			onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
		});

		runtime.publish({ type: "content", text: "partial" });
		runtime.stop();

		expect(runtime.signal.aborted).toBe(true);
		expect(runtime.isStopRequested).toBe(true);
		expect(checkpoints).toEqual([{ content: "partial", reasoning: "", latestEventId: 1 }]);
		expect(runtime.state.status).toBe("active");

		// Provider frames and terminal callbacks can arrive after AbortSignal is
		// observed. They must not append output or replace the explicit Stop.
		runtime.publish({ type: "content", text: "late" });
		runtime.fail("late provider failure");
		runtime.complete();
		runtime.markStopped();
		runtime.markStopped();

		expect(runtime.state.status).toBe("stopped");
		expect(runtime.state.content).toBe("partial");
		expect(runtime.state.terminalReason).toBeNull();
		expect(checkpoints).toHaveLength(1);
	});

	test("graceful shutdown flushes and stops the production default registry", () => {
		const database = openDatabase({ path: ":memory:" });
		const registry = defaultGenerationRuntime();
		const generationId = 91_234;
		registry.remove(generationId);
		let stopped = false;
		const checkpoints: string[] = [];
		try {
			const runtime = registry.start({
				generationId,
				conversationId: 3,
				messageId: 12,
				variantId: 18,
				startedAt: "2026-08-27T00:00:00.000Z",
				checkpoint: { eventInterval: 99, intervalMs: 0 },
				onCheckpoint: ({ content }) => checkpoints.push(content),
				onStop: () => { stopped = true; },
			});
			runtime.publish({ type: "content", text: "production partial" });

			gracefullyShutdownGenerations(database);

			expect(checkpoints).toEqual(["production partial"]);
			expect(stopped).toBe(true);
			expect(runtime.signal.aborted).toBe(true);
		} finally {
			registry.remove(generationId);
			database.close();
		}
	});

	test("selects the process registry without a database and reuses injected database scope", () => {
		const database = openDatabase({ path: ":memory:" });
		try {
			const processRegistry = generationRuntimeFor(undefined);
			const databaseRegistry = generationRuntimeFor(database);

			expect(processRegistry).toBe(defaultGenerationRuntime());
			expect(generationRuntimeFor(database)).toBe(databaseRegistry);
			expect(databaseRegistry).not.toBe(processRegistry);
		} finally {
			database.close();
		}
	});
});
