import { describe, expect, test } from "bun:test";
import { jevRequest, packJev } from ".";

const build = (batch: readonly { id: string; size: number }[]) => jevRequest("jev", {}, Object.fromEntries(batch.map(({ id, size }) => [id, { text: "x".repeat(size) }])));
const items = (sizes: readonly number[]) => sizes.map((size, index) => ({ id: `q${index}`, size }));

describe("packJev", () => {
	test("fills each request to the Jev limits and keeps item order", () => {
		const packed = packJev(items([40_000, 40_000, 40_000, 40_000, 40_000, 40_000, 40_000]), build, "too big");
		expect(packed.map((request) => request.items.map((item) => item.id))).toEqual([["q0", "q1", "q2"], ["q3", "q4", "q5"], ["q6"]]);
		expect(packed.every((request) => request.fits)).toBe(true);
	});

	test("starts a new request when the next item would not fit, even after small items", () => {
		expect(packJev(items([10, 10, 125_000, 10_000, 10]), build, "too big").map((request) => request.items.length)).toEqual([3, 2]);
	});

	test("caps the items per request", () => {
		expect(packJev(items([1, 1, 1, 1, 1]), build, "too big", 2).map((request) => request.items.length)).toEqual([2, 2, 1]);
	});

	test("throws the caller's error when one item cannot fit alone", () => {
		expect(() => packJev(items([10, 200_000]), build, "too big")).toThrow("too big");
	});

	test("packs nothing for no items", () => {
		expect(packJev([], build, "too big")).toEqual([]);
	});
});
