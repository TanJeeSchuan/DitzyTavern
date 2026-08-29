import { describe, expect, test } from "bun:test";
import { createAsyncEffectGuard } from "./use-async";

describe("createAsyncEffectGuard", () => {
	test("a fresh guard is live so in-flight results may apply", () => {
		const guard = createAsyncEffectGuard();
		expect(guard.isCancelled()).toBe(false);
	});

	test("cancel ends the activation so late results stop applying", () => {
		const guard = createAsyncEffectGuard();
		guard.cancel();
		expect(guard.isCancelled()).toBe(true);
	});

	test("cancel is idempotent and later checks stay cancelled", () => {
		const guard = createAsyncEffectGuard();
		guard.cancel();
		guard.cancel();
		expect(guard.isCancelled()).toBe(true);
	});

	test("each activation owns an independent guard", () => {
		const first = createAsyncEffectGuard();
		const second = createAsyncEffectGuard();
		first.cancel();
		expect(first.isCancelled()).toBe(true);
		expect(second.isCancelled()).toBe(false);
	});
});

// The contract useAsyncEffect composes for its callers: the effect maps
// cleanup to cancel, and the task's promise callbacks apply their results
// only while the guard is live. These cases exercise that composition with
// the same primitives the hook wires together.
describe("the guarded-task contract", () => {
	test("a result arriving after cancel never applies", async () => {
		const guard = createAsyncEffectGuard();
		let resolve: (value: string) => void = () => undefined;
		const applied: string[] = [];
		const task = async (isCancelled: () => boolean) => {
			const value = await new Promise<string>((res) => {
				resolve = res;
			});
			if (!isCancelled()) applied.push(value);
		};
		const running = task(guard.isCancelled);
		guard.cancel();
		resolve("late");
		await running;
		expect(applied).toEqual([]);
	});

	test("a result arriving before cancel applies normally", async () => {
		const guard = createAsyncEffectGuard();
		const applied: string[] = [];
		const task = async (isCancelled: () => boolean) => {
			const value = await Promise.resolve("early");
			if (!isCancelled()) applied.push(value);
		};
		await task(guard.isCancelled);
		guard.cancel();
		expect(applied).toEqual(["early"]);
	});
});
