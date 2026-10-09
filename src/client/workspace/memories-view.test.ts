import { describe, expect, test } from "bun:test";
import type { ConversationMemories } from "../memories";
import {
	groupEntriesByPeople,
	memoryCastMembers,
	memoryEntries,
	memoryPositions,
	type MemoryClaim,
	type MemorySource,
} from "./memories-view";

const claim = (text: string, people: string[] = [], attribution = "Sage"): MemoryClaim => ({
	claim: text,
	attribution,
	people,
	evidence: [],
	judgment: { support: "supported", attribution: "correct", usefulness: "retain", probabilities: {}, confidence: {} },
});

const source = (messageId: number, claims: MemoryClaim[], selected = true): MemorySource => ({
	messageId,
	variantId: messageId * 10,
	selected,
	status: "complete",
	error: null,
	revision: 1,
	ownership: "automatic",
	sourceChanged: false,
	claims,
	indexing: { status: "ready", pendingCount: 0, error: null },
});

const path = (...messageIds: number[]) =>
	messageIds.map((messageId) => ({ messageId, author: "Sage", authorParticipantId: 1 }));

const memories = (cast: ConversationMemories["cast"]): ConversationMemories => ({
	revision: 1,
	cursor: "0",
	labelRevision: 1,
	identities: {},
	cast,
	labelMerges: [],
	sources: [],
	path: [],
});

const cast = memoryCastMembers(
	[{ id: 1, name: "Sage" }, { id: 2, name: "Frost" }],
	memories([{ id: 1, names: ["Sage", "The Sage"] }, { id: 2, names: ["Frost"] }]),
);

describe("memory entries", () => {
	const sources = [
		source(10, [claim("The gate opens.", ["The Sage"]), claim("A bell rings.", ["The Sage"], "The Narrator")]),
		source(20, [claim("Winter arrives.", ["Frost"])]),
		source(30, [claim("The hall empties.")]),
	];
	const position = memoryPositions(path(10, 20, 30));
	const claimsOf = (found: ReturnType<typeof memoryEntries>) =>
		found.map((entry) => [entry.source.messageId, entry.index, entry.claim.claim]);

	test("lists claims from the newest Message first, tracking each claim's index", () => {
		expect(claimsOf(memoryEntries(sources, position, null, ""))).toEqual([
			[30, 0, "The hall empties."],
			[20, 0, "Winter arrives."],
			[10, 0, "The gate opens."],
			[10, 1, "A bell rings."],
		]);
	});

	test("a focused Message keeps only its own claims", () => {
		expect(claimsOf(memoryEntries(sources, position, 20, ""))).toEqual([[20, 0, "Winter arrives."]]);
	});

	test("the search matches the claim, its attribution, or its people", () => {
		expect(claimsOf(memoryEntries(sources, position, null, "bell"))).toEqual([[10, 1, "A bell rings."]]);
		expect(claimsOf(memoryEntries(sources, position, null, "  NARRATOR "))).toEqual([[10, 1, "A bell rings."]]);
		expect(claimsOf(memoryEntries(sources, position, null, "frost"))).toEqual([[20, 0, "Winter arrives."]]);
		expect(memoryEntries(sources, position, null, "nothing")).toEqual([]);
	});

	test("a Message missing from the path sorts behind the known ones", () => {
		const stray = source(99, [claim("An orphaned Memory.")]);
		expect(claimsOf(memoryEntries([...sources, stray], position, null, "")).at(-1)).toEqual([99, 0, "An orphaned Memory."]);
	});
});

describe("memory cast", () => {
	test("a Participant without Memory labels gets an empty label list", () => {
		const widened = memoryCastMembers([{ id: 3, name: "Moss" }], memories([{ id: 4, names: ["Mossy"] }]));
		expect(widened).toEqual([{ id: 3, name: "Moss", names: [] }]);
		expect(memoryCastMembers([{ id: 3, name: "Moss" }], null)[0]?.names).toEqual([]);
	});
});

describe("memory people groups", () => {
	test("claims naming the same people collapse into one group, people in Cast order", () => {
		const entries = memoryEntries([
			source(10, [claim("A bell rings.", ["Frost", "The Sage"]), claim("A door opens.", ["The Sage", "Frost"])]),
		], memoryPositions(path(10)), null, "");
		const groups = groupEntriesByPeople(entries, cast);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.people).toEqual(["The Sage", "Frost"]);
		expect(groups[0]?.key).toBe(JSON.stringify(["The Sage", "Frost"]));
		expect(groups[0]?.entries.map((entry) => entry.claim.claim)).toEqual(["A bell rings.", "A door opens."]);
	});

	test("groups follow the Cast, with strangers next and unlabelled claims last", () => {
		const entries = memoryEntries([
			source(10, [
				claim("The hall empties."),
				claim("Winter arrives.", ["Frost"]),
				claim("The gate opens.", ["Sage"]),
				claim("A stranger speaks.", ["Stranger"]),
			]),
		], memoryPositions(path(10)), null, "");
		expect(groupEntriesByPeople(entries, cast).map((group) => group.people)).toEqual([
			["Sage"],
			["Frost"],
			["Stranger"],
			[],
		]);
	});

	test("groups of the same Cast rank order by fewer people, then more claims", () => {
		const entries = memoryEntries([
			source(10, [
				claim("Sage alone.", ["Sage"]),
				claim("Sage and Frost.", ["Sage", "Frost"]),
				claim("Sage and Frost again.", ["Sage", "Frost"]),
				claim("Sage and Moss.", ["Sage", "Moss"]),
			]),
		], memoryPositions(path(10)), null, "");
		expect(groupEntriesByPeople(entries, cast).map((group) => [group.people, group.entries.length])).toEqual([
			[["Sage"], 1],
			[["Sage", "Frost"], 2],
			[["Sage", "Moss"], 1],
		]);
	});
});
