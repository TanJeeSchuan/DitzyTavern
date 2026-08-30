import { describe, expect, test } from "bun:test";
import { removalConfirmationCopy } from "./cast-remove";

const seated = {
	eligible: false,
	reason: "control-assigned" as const,
	deletionMode: null,
	affectedGenerationCount: 0,
};

const tombstone = (affectedGenerationCount: number) => ({
	eligible: true,
	reason: null,
	deletionMode: "tombstone" as const,
	affectedGenerationCount,
});

const hardDelete = {
	eligible: true,
	reason: null,
	deletionMode: "hard-delete" as const,
	affectedGenerationCount: 0,
};

describe("removalConfirmationCopy", () => {
	test("a tombstoning removal names the mode and the exact regeneration loss before confirmation", () => {
		const copy = removalConfirmationCopy("Maren Voss", tombstone(1));
		expect(copy.title).toBe("Remove Maren Voss?");
		expect(copy.impact).toContain("tombstone");
		expect(copy.impact).toContain("1 Message will");
		expect(copy.impact).toContain("new sibling Variants");
		expect(copy.confirmLabel).toBe("Remove");
	});

	test("a tombstoning removal with no regeneration loss still explains history retention", () => {
		const copy = removalConfirmationCopy("Maren Voss", tombstone(0));
		expect(copy.impact).toContain("tombstone");
		expect(copy.impact).toContain("history keeps displaying");
		expect(copy.impact).not.toContain("Message");
	});

	test("a hard deletion states the permanent result", () => {
		const copy = removalConfirmationCopy("Juno Ashfeld", hardDelete);
		expect(copy.title).toBe("Remove Juno Ashfeld?");
		expect(copy.impact).toContain("permanently deletes");
		expect(copy.impact).not.toContain("tombstone");
		expect(copy.confirmLabel).toBe("Remove");
	});

	test("a seated Participant explains the Control change instead of an impact", () => {
		const copy = removalConfirmationCopy("Writer", seated);
		expect(copy.title).toBe("Writer cannot be removed");
		expect(copy.impact).toContain("Control seat");
		expect(copy.confirmLabel).toBe("Close");
	});
});
