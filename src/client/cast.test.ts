import { describe, expect, test } from "bun:test";
import {
	controlChangeDescription,
	libraryPickerEntries,
	usedCharacterCount,
} from "./cast";
import type { CharacterSummary } from "./character-library";

const summary = (overrides: Partial<CharacterSummary>): CharacterSummary => ({
	id: 1,
	name: "Maren Voss",
	revision: 0,
	pinned: false,
	preview: "Lighthouse archivist.",
	provenanceReferenceCount: 0,
	...overrides,
});

const cast = (entries: { id: number; sourceCharacterId: number | null }[]) =>
	entries.map((entry) => ({
		id: entry.id,
		sourceCharacterId: entry.sourceCharacterId,
	}));

describe("libraryPickerEntries", () => {
	test("appends duplicate ordinals in library order and shows each preview", () => {
		const characters = [
			summary({ id: 1, name: "Maren Voss", pinned: true }),
			summary({ id: 2, name: "Maren Voss" }),
			summary({ id: 3, name: "Juno Ashfeld" }),
		];
		const entries = libraryPickerEntries(
			characters,
			cast([
				{ id: 10, sourceCharacterId: 1 },
				{ id: 11, sourceCharacterId: 1 },
			]),
		);
		expect(entries.map((entry) => entry.label)).toEqual([
			"Maren Voss",
			"Maren Voss (2)",
			"Juno Ashfeld",
		]);
		expect(entries[0]?.preview).toBe("Lighthouse archivist.");
	});

	test("counts how many times a Character is already forked without hiding it", () => {
		const characters = [summary({ id: 7, name: "Twin Source" })];
		const entries = libraryPickerEntries(
			characters,
			cast([
				{ id: 10, sourceCharacterId: 7 },
				{ id: 11, sourceCharacterId: 7 },
				{ id: 12, sourceCharacterId: null },
			]),
		);
		expect(entries[0]?.usedCount).toBe(2);
		// The Character remains selectable despite the used count.
		expect(entries).toHaveLength(1);
	});

	test("reports a zero used-count for never-forked Characters", () => {
		const characters = [summary({ id: 7, name: "Fresh" })];
		const entries = libraryPickerEntries(characters, cast([]));
		expect(entries[0]?.usedCount).toBe(0);
	});
});

describe("usedCharacterCount", () => {
	test("counts only Participants carrying that provenance", () => {
		expect(
			usedCharacterCount(
				cast([
					{ id: 1, sourceCharacterId: 9 },
					{ id: 2, sourceCharacterId: 9 },
					{ id: 3, sourceCharacterId: null },
				]),
				9,
			),
		).toBe(2);
		expect(usedCharacterCount(cast([]), 9)).toBe(0);
	});
});

describe("controlChangeDescription", () => {
	const conversation = (human: number | null, model: number | null) => ({
		control: { humanParticipantId: human, modelParticipantId: model },
		cast: [
			{
				id: 1,
				duplicateLabel: "Writer",
			},
			{
				id: 2,
				duplicateLabel: "Maren Voss",
			},
			{
				id: 3,
				duplicateLabel: "Juno Ashfeld",
			},
		],
	});

	test("describes selecting the opposite seat's occupant as a swap", () => {
		const description = controlChangeDescription(
			conversation(1, 2),
			"model",
			1,
		);
		expect(description.kind).toBe("swap");
		expect(description.notice).toContain("Swap:");
		expect(description.notice).toContain("Writer");
		expect(description.notice).toContain("Maren Voss");

		const otherSide = controlChangeDescription(conversation(1, 2), "human", 2);
		expect(otherSide.kind).toBe("swap");
	});

	test("describes unseated assignment as a replacement of one seat", () => {
		const description = controlChangeDescription(
			conversation(1, 2),
			"human",
			3,
		);
		expect(description.kind).toBe("replace");
		expect(description.notice).toContain("Juno Ashfeld");
		expect(description.notice).toContain("removable");
	});

	test("reports no-change for the current occupant", () => {
		const description = controlChangeDescription(conversation(1, 2), "human", 1);
		expect(description.kind).toBe("no-change");
	});

	test("a two-person Cast swap is described the same way as a larger Cast", () => {
		const twoPerson = conversation(1, 2);
		expect(controlChangeDescription(twoPerson, "model", 1).kind).toBe("swap");
		expect(controlChangeDescription(twoPerson, "human", 2).kind).toBe("swap");
	});
});