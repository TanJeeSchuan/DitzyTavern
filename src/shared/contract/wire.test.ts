import { beforeAll, describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";

import { numericWire } from "./wire";
import { registerWireFormats } from "./wire-formats";

describe("numericWire", () => {
	beforeAll(() => registerWireFormats());

	test("accepts numbers and numeric strings", () => {
		expect(Value.Check(numericWire, 5)).toBe(true);
		expect(Value.Check(numericWire, "12")).toBe(true);
		expect(Value.Check(numericWire, "0")).toBe(true);
	});

	test("rejects non-numeric values", () => {
		expect(Value.Check(numericWire, "abc")).toBe(false);
		expect(Value.Check(numericWire, "")).toBe(false);
		expect(Value.Check(numericWire, null)).toBe(false);
		expect(Value.Check(numericWire, true)).toBe(false);
	});

	test("decodes to the number handlers and derived types see", () => {
		expect(Value.Decode(numericWire, "12")).toBe(12);
		expect(Value.Decode(numericWire, 3)).toBe(3);
		expect(Value.Decode(numericWire, "0")).toBe(0);
	});
});
