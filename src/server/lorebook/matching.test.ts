import { describe, expect, test } from "bun:test";
import type { LoreEntryFields } from "../../shared/contract/lorebook";
import { InvalidLorebookExpressionError } from "./errors";
import { matchLoreEntry } from "./matching";

const entry = (overrides: Partial<LoreEntryFields> = {}): LoreEntryFields => ({
	title: "Entry",
	content: "The fact.",
	keywords: ["Silver Keep"],
	semanticTriggers: [],
	matchOperator: "or",
	always: false,
	requireAny: [],
	requireAll: [],
	excludeAny: [],
	excludeAll: [],
	caseSensitive: false,
	wholeWord: true,
	keywordMode: "literal",
	regexFlags: "",
	
	priority: 0,
	enabled: true,
	...overrides,
});

describe("lore entry matching", () => {
	test("matches case-insensitive whole-word phrases inside one Message", () => {
		expect(matchLoreEntry(entry(), [{ content: "The SILVER KEEP stands." }]).active).toBe(true);
		expect(matchLoreEntry(entry(), [{ content: "The Silver Keeper stands." }]).active).toBe(false);
		expect(matchLoreEntry(entry(), [{ content: "Silver" }, { content: "Keep" }]).active).toBe(false);
	});

	test("supports case-sensitive and substring literal modes", () => {
		expect(matchLoreEntry(entry({ caseSensitive: true }), [{ content: "silver keep" }]).active).toBe(false);
		expect(matchLoreEntry(entry({ wholeWord: false }), [{ content: "Silver Keeper" }]).active).toBe(true);
	});

	test("keeps whole-word boundaries across Unicode code points", () => {
		expect(matchLoreEntry(entry({ keywords: ["𐐀"] }), [{ content: "𐐀" }]).active).toBe(true);
		expect(matchLoreEntry(entry({ keywords: ["silver"] }), [{ content: "𐐀silver" }]).active).toBe(false);
		expect(matchLoreEntry(entry({ keywords: ["silver"] }), [{ content: "silver𐐀" }]).active).toBe(false);
	});

	test("supports slash-delimited regular expressions and reports invalid syntax", () => {
		expect(matchLoreEntry(entry({ keywordMode: "regex", keywords: ["/silver\\s+keep/i"] }), [{ content: "Silver   Keep" }]).active).toBe(true);
		expect(() => matchLoreEntry(entry({ keywordMode: "regex", keywords: ["/[broken/"] }), [{ content: "anything" }])).toThrow(InvalidLorebookExpressionError);
	});

	test("runs backtracking-prone regex expressions in linear time", () => {
		const result = matchLoreEntry(entry({ keywordMode: "regex", keywords: ["(a+)+$"] }), [{ content: `${"a".repeat(20_000)}b` }]);
		expect(result.active).toBe(false);
	});

	test("combines secondary conditions across the complete scan window", () => {
		const matched = matchLoreEntry(entry({
		requireAny: ["moon"],
		requireAll: ["night", "quiet"],
		excludeAny: ["day"],
		excludeAll: ["storm", "rain"],
	}), [
			{ content: "Silver Keep at night." },
			{ content: "The moon is quiet." },
		]);
		expect(matched.active).toBe(true);
		expect(matched.secondary.requireAll.matchedExpressions).toEqual(["night", "quiet"]);
		expect(matchLoreEntry(entry({ excludeAny: ["moon"] }), [{ content: "Silver Keep and moon." }]).active).toBe(false);
	});

	test("Always bypasses primary and secondary conditions, while disabled entries do not match", () => {
		expect(matchLoreEntry(entry({ always: true, keywords: [], excludeAny: ["anything"] }), [{ content: "anything" }]).active).toBe(true);
		expect(matchLoreEntry(entry({ enabled: false, always: true }), [{ content: "Silver Keep" }]).skipped).toBe(true);
	});

	test("uses keyword fallback for AND entries and skips semantic-only entries", () => {
		const fallback = matchLoreEntry(entry({ keywords: ["Silver Keep"], semanticTriggers: ["a fortified place"], matchOperator: "and" }), [{ content: "Silver Keep" }], { available: false, threshold: 0.7, fallbackReason: "Typesafe Jev request failed with HTTP 503." });
		expect(fallback.active).toBe(true);
		expect(fallback.fallback).toBe(true);
		expect(fallback.semantic.fallbackReason).toBe("Typesafe Jev request failed with HTTP 503.");
		expect(matchLoreEntry(entry({ keywords: [], semanticTriggers: ["a fortified place"] }), [{ content: "Silver Keep" }], { available: false, threshold: 0.7 }).active).toBe(false);
	});

	test("uses semantic evidence only after a complete semantic pass", () => {
		const result = matchLoreEntry(entry({ keywords: [], semanticTriggers: ["fortified place"] }), [{ content: "A stronghold overlooks the valley." }], {
			available: true,
			threshold: 0.5,
			matches: [{ trigger: "fortified place", score: 0.81 }],
		});
		expect(result.active).toBe(true);
		expect(result.semantic.matches).toEqual([{ trigger: "fortified place", score: 0.81 }]);
	});

	test("retains the strongest semantic evidence below the activation threshold", () => {
		const result = matchLoreEntry(entry({ keywords: [], semanticTriggers: ["fortified place"] }), [{ content: "A distant valley." }], {
			available: true,
			threshold: 0.5,
			matches: [{ trigger: "fortified place", score: 0.42 }],
		});
		expect(result.active).toBe(false);
		expect(result.semantic.matches).toEqual([{ trigger: "fortified place", score: 0.42 }]);
	});
});
