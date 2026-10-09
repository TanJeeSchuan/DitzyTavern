import { describe, expect, test } from "bun:test";
import { decisionRequest, largestFittingBatch, packDecisions } from ".";

const build = (batch: readonly { id: string; size: number }[]) => decisionRequest({ model: "jev", stateTokenLimit: 16000 }, {},
	Object.fromEntries(batch.map(({ id, size }) => [id, { type: "noul", text: "x".repeat(size) }])));
const items = (sizes: readonly number[]) => sizes.map((size, index) => ({ id: `q${index}`, size }));

describe("packDecisions", () => {
	test("fills each request to the Decision Model limits and keeps item order", () => {
		const packed = packDecisions(items([40_000, 40_000, 40_000, 40_000, 40_000, 40_000, 40_000]), build, "too big");
		expect(packed.map((request) => request.items.map((item) => item.id))).toEqual([["q0", "q1", "q2"], ["q3", "q4", "q5"], ["q6"]]);
	});

	test("starts a new request when the next item would not fit, even after small items", () => {
		expect(packDecisions(items([10, 10, 125_000, 10_000, 10]), build, "too big").map((request) => request.items.length)).toEqual([3, 2]);
	});

	test("caps the items per request", () => {
		expect(packDecisions(items([1, 1, 1, 1, 1]), build, "too big", 2).map((request) => request.items.length)).toEqual([2, 2, 1]);
	});

	test("throws the caller's error when one item cannot fit alone", () => {
		expect(() => packDecisions(items([10, 200_000]), build, "too big")).toThrow("too big");
	});

	test("packs nothing for no items", () => {
		expect(packDecisions([], build, "too big")).toEqual([]);
	});

	test("largestFittingBatch takes the longest fitting prefix", () => {
		expect(largestFittingBatch(items([40_000, 40_000, 40_000, 40_000]), build)?.items.map((item) => item.id)).toEqual(["q0", "q1", "q2"]);
		expect(largestFittingBatch(items([200_000, 10]), build)).toBeUndefined();
	});

	test("takes the longest fitting prefix of a large overflowing trigger batch", () => {
		const triggers = items(Array.from({ length: 256 }, () => 1_000));
		const packed = largestFittingBatch(triggers, build);
		if (packed === undefined) throw new Error("No trigger batch fit.");
		expect(build(packed.items).fits).toBe(true);
		expect(build(triggers.slice(0, packed.items.length + 1)).fits).toBe(false);
	});
});
