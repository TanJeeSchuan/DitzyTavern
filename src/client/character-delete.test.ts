import { describe, expect, test } from "bun:test";
import {
	deletionConfirmationCopy,
	deletionResultNotice,
	usedCountLabel,
} from "./character-delete";
import type { CharacterDeletionImpact } from "./character-library";

const impact = (
	provenanceReferenceCount: number,
	deletionMode: CharacterDeletionImpact["deletionMode"],
): CharacterDeletionImpact => ({ provenanceReferenceCount, deletionMode });

// Focused UI-boundary tests for the Character Library's deletion
// presentation: reference counts, confirmation copy that clearly
// distinguishes hard deletion from retained tombstoning, and success
// notices. The deletion behavior itself lives behind the server seam tests.
describe("deletionConfirmationCopy", () => {
	test("an unreferenced Character confirms a permanent hard delete", () => {
		const copy = deletionConfirmationCopy("Maren Voss", impact(0, "hard-delete"));
		expect(copy.title).toBe("Delete Maren Voss?");
		expect(copy.impact).toContain("removes it from the Library permanently");
		expect(copy.impact).not.toContain("tombstone");
		expect(copy.confirmLabel).toBe("Yes, delete permanently");
	});

	test("a referenced Character names the reference count and the retained tombstone", () => {
		const copy = deletionConfirmationCopy("Maren Voss", impact(3, "tombstone"));
		expect(copy.title).toBe("Delete Maren Voss?");
		expect(copy.impact).toContain("3 Participants");
		expect(copy.impact).toContain("hidden tombstone");
		expect(copy.impact).toContain("provenance");
		expect(copy.confirmLabel).toBe("Yes, retain a hidden tombstone");
	});

	test("a single reference reads grammatically and still states the mode", () => {
		const copy = deletionConfirmationCopy("Juno Ashfeld", impact(1, "tombstone"));
		expect(copy.impact).toContain("1 Participant");
		expect(copy.impact).not.toContain("1 Participants");
		expect(copy.confirmLabel).toBe("Yes, retain a hidden tombstone");
	});
});

describe("usedCountLabel", () => {
	test("labels zero, one, and repeated provenance references", () => {
		expect(usedCountLabel(0)).toBe("Not used in any Chat");
		expect(usedCountLabel(1)).toBe("Used 1 time");
		expect(usedCountLabel(4)).toBe("Used 4 times");
	});
});

describe("deletionResultNotice", () => {
	test("a tombstone result reports removal with retained provenance", () => {
		const notice = deletionResultNotice({ deletionMode: "tombstone" });
		expect(notice).toContain("removed from the Library");
		expect(notice).toContain("keep their definitions and provenance");
		expect(notice).toContain("cannot be restored");
	});

	test("a hard deletion reports a permanent removal and nothing else changes", () => {
		const notice = deletionResultNotice({ deletionMode: "hard-delete" });
		expect(notice).toContain("deleted permanently");
		expect(notice).toContain("Existing Chat Participants are unchanged");
	});
});