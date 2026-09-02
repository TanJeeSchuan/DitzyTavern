import { describe, expect, test } from "bun:test";
import { compareModelIds } from "./model-identifier";

describe("compareModelIds", () => {
	test("sorts case-insensitively first", () => {
		const models = ["zeta", "Alpha", "beta", "Gamma"];
		models.sort(compareModelIds);
		expect(models).toEqual(["Alpha", "beta", "Gamma", "zeta"]);
	});

	test("breaks ties by exact case when folded strings match", () => {
		// In ASCII, 'A' (65) < 'a' (97), so "model-A" < "model-a"
		const models = ["model-a", "model-A"];
		models.sort(compareModelIds);
		expect(models).toEqual(["model-A", "model-a"]);
	});

	test("returns 0 for identical strings", () => {
		expect(compareModelIds("model-v1", "model-v1")).toBe(0);
	});
});
