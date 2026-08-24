import { describe, expect, test } from "bun:test";
import { duplicateLabel, resolveControlChange } from "./cast";

describe("duplicateLabel", () => {
	test("keeps the first occurrence plain and appends ordinals to later duplicates", () => {
		expect(duplicateLabel("Maren Voss", 1)).toBe("Maren Voss");
		expect(duplicateLabel("Maren Voss", 2)).toBe("Maren Voss (2)");
		expect(duplicateLabel("Maren Voss", 3)).toBe("Maren Voss (3)");
	});

	test("treats a zero or negative occurrence as the plain name", () => {
		expect(duplicateLabel("Writer", 0)).toBe("Writer");
		expect(duplicateLabel("Writer", -1)).toBe("Writer");
	});

	test("preserves case and Unicode exactly inside the label", () => {
		expect(duplicateLabel("Juno Ashfeld", 2)).toBe("Juno Ashfeld (2)");
		expect(duplicateLabel("Åse", 2)).toBe("Åse (2)");
	});
});

describe("resolveControlChange", () => {
	const control = (human: number | null, model: number | null) => ({
		humanParticipantId: human,
		modelParticipantId: model,
	});

	test("reports no-change when the Participant already occupies the chosen seat", () => {
		expect(resolveControlChange(control(1, 2), "human", 1)).toBe("no-change");
		expect(resolveControlChange(control(1, 2), "model", 2)).toBe("no-change");
	});

	test("reports a swap when the assigned Participant is the opposite seat's occupant", () => {
		expect(resolveControlChange(control(1, 2), "human", 2)).toBe("swap");
		expect(resolveControlChange(control(1, 2), "model", 1)).toBe("swap");
		// Two-person Casts can always swap.
		expect(resolveControlChange(control(1, 2), "model", 1)).toBe("swap");
	});

	test("reports a replace when an unseated Participant takes over a seat", () => {
		expect(resolveControlChange(control(1, 2), "human", 3)).toBe("replace");
		expect(resolveControlChange(control(1, 2), "model", 3)).toBe("replace");
		expect(resolveControlChange(control(null, 2), "human", 3)).toBe("replace");
		expect(resolveControlChange(control(1, null), "model", 3)).toBe("replace");
	});
});