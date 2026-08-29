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
