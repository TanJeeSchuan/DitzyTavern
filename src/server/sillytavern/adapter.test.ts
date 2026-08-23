import { describe, expect, test } from "bun:test";
import {
	ARCHIVE_KEY,
	ARCHIVE_NAMESPACE,
	IMPORT_KEYS,
	IMPORT_NAMESPACE,
	IMPORTER_VERSION,
	RESOLVED_BLANK_AUTHOR_NAME,
	VARIANT_KEYS,
	parseSillyTavernChatJsonl,
} from "./adapter";
import type { SillyTavernImportMeta } from "./adapter";
import { SillyTavernImportError } from "./errors";
import {
	blankNameFixture as blankName,
	emptyContentFixture as emptyContent,
	headerFixture as header,
	jsonl,
	provenancedPayloadFixture as provenancedPayload,
	rulershipFixture as second,
	swipeRecordFixture as swiped,
	writerFixture as first,
} from "./fixtures";

const meta: SillyTavernImportMeta = {
	name: "lantern-house",
	filename: "lantern-house.jsonl",
	sha256: "0f5c3e0a9d0c8f5b3a9e4d6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6",
};

// Imported Participants start with an empty typed Prompt and no openings:
// the resolved identity carries only a native nonblank name.
const importedSeed = (name: string) => ({
	definition: {
		name,
		prompt: {
			systemInstruction: "",
			identity: "",
			scenario: "",
			exampleDialogue: "",
			postHistoryInstruction: "",
		},
		openings: [],
	},
});

describe("SillyTavern JSONL adapter", () => {
	test("maps a header and payload-only records into a generic creation input", () => {
		const { input } = parseSillyTavernChatJsonl(
			jsonl([header, first, second, blankName]),
			meta,
		);

		expect(input.name).toBe("lantern-house");
		expect(input.participants).toEqual([
			importedSeed("Writer"),
			importedSeed("Rulership"),
			importedSeed(RESOLVED_BLANK_AUTHOR_NAME),
		]);
		// Deterministic seating by first resolved appearance: Writer human,
		// Rulership model, the blank-resolved Participant unseated. Role
		// hints (is_user etc.) had no effect on either identity or Control.
		expect(input.control).toEqual({ human: 0, model: 1 });
		expect(input.messages).toEqual([
			{
				timestamp: "2026-08-08T12:53:02.008Z",
				authorParticipantIndex: 0,
				data: [
					{
						namespace: IMPORT_NAMESPACE,
						key: IMPORT_KEYS.authorName,
						value: "Writer",
					},
				],
				variants: [
					{
						content: "tanjs is a kinda new junior trainer",
						timestamp: "2026-08-08T12:53:02.008Z",
						selected: true,
					},
				],
			},
			{
				timestamp: "2026-08-08T13:04:55.256Z",
				authorParticipantIndex: 1,
				data: [
					{
						namespace: IMPORT_NAMESPACE,
						key: IMPORT_KEYS.authorName,
						value: "Rulership",
					},
				],
				variants: [
					{
						content: "Rulership watches the track in silence.",
						timestamp: "2026-08-08T13:04:55.256Z",
						selected: true,
					},
				],
			},
			{
				timestamp: "2026-08-08T13:10:00.000Z",
				authorParticipantIndex: 2,
				data: [
					{
						namespace: IMPORT_NAMESPACE,
						key: IMPORT_KEYS.authorName,
						value: "",
					},
				],
				variants: [
					{
						content: "🔥 Wait, truly?",
						timestamp: "2026-08-08T13:10:00.000Z",
						selected: true,
					},
				],
			},
		]);
	});

	test("preserves a blank captured author name and reports it as a warning", () => {
		const { input, report } = parseSillyTavernChatJsonl(
			jsonl([header, first, blankName]),
			meta,
		);

		const [authorEntry] = input.messages?.[1]?.data ?? [];
		expect(authorEntry).toEqual({
			namespace: IMPORT_NAMESPACE,
			key: IMPORT_KEYS.authorName,
			value: "",
		});
		expect(report.warnings).toEqual([
			"Message at position 2 has a blank captured author name.",
		]);
	});

	test("keeps the first nonempty record as the source header", () => {
		const source = `\n\n${JSON.stringify(header)}\n${JSON.stringify(first)}\n\n`;
		const { report } = parseSillyTavernChatJsonl(source, meta);
		expect(report.counts).toEqual({ messages: 1, variants: 1 });
	});

	test("stores the canonical archive and import identity as separate conversation entries", () => {
		const { input, report } = parseSillyTavernChatJsonl(
			jsonl([header, first, second]),
			meta,
		);

		const archive = input.data?.find(
			(entry) =>
				entry.namespace === ARCHIVE_NAMESPACE && entry.key === ARCHIVE_KEY,
		);
		expect(archive).toBeDefined();
		expect(JSON.parse(archive?.value ?? "")).toEqual({
			header,
			messages: [first, second],
		});

		const importEntries = input.data?.filter(
			(entry) => entry.namespace === IMPORT_NAMESPACE,
		);
		expect(importEntries).toEqual([
			{
				namespace: IMPORT_NAMESPACE,
				key: IMPORT_KEYS.integrity,
				value: "9543f21f-8aab-42c8-92a4-1f6453d4b63c",
			},
			{
				namespace: IMPORT_NAMESPACE,
				key: IMPORT_KEYS.sha256,
				value: meta.sha256,
			},
			{
				namespace: IMPORT_NAMESPACE,
				key: IMPORT_KEYS.filename,
				value: "lantern-house.jsonl",
			},
			{
				namespace: IMPORT_NAMESPACE,
				key: IMPORT_KEYS.importerVersion,
				value: IMPORTER_VERSION,
			},
			{
				namespace: IMPORT_NAMESPACE,
				key: IMPORT_KEYS.countsMessages,
				value: "2",
			},
			{
				namespace: IMPORT_NAMESPACE,
				key: IMPORT_KEYS.countsVariants,
				value: "2",
			},
		]);
		expect(report).toEqual({
			importerVersion: IMPORTER_VERSION,
			source: {
				filename: "lantern-house.jsonl",
				sha256: meta.sha256,
				integrity: "9543f21f-8aab-42c8-92a4-1f6453d4b63c",
			},
			counts: { messages: 2, variants: 2 },
			warnings: [],
		});
	});

	test("leaves warnings and report entries to the orchestration step", () => {
		const { input } = parseSillyTavernChatJsonl(jsonl([header, first]), meta);
		expect(
			input.data?.some(
				(entry) =>
					entry.key === IMPORT_KEYS.warnings ||
					entry.key === IMPORT_KEYS.reportJson,
			),
		).toBe(false);
	});

	test("keeps unknown and source-only fields value-lossless in the archive only", () => {
		const { input } = parseSillyTavernChatJsonl(
			jsonl([header, first, second]),
			meta,
		);

		const archive = input.data?.find(
			(entry) =>
				entry.namespace === ARCHIVE_NAMESPACE && entry.key === ARCHIVE_KEY,
		);
		// SAFETY: archive.value was produced by JSON.stringify over the same fixture objects.
		const messages = JSON.parse(archive?.value ?? "").messages as unknown[];
		expect(messages[0]).toEqual(first);
		expect(messages[1]).toEqual(second);

		// The projection derives no role: the native Messages carry only the
		// captured author name, while role flags stay inside the raw archive.
		const projection = JSON.stringify(input.messages);
		expect(projection).not.toContain("is_user");
		expect(projection).not.toContain("is_system");
		expect(projection).not.toContain("future_field");
		expect(projection).not.toContain("title");
	});

	test("preserves empty payload content as an empty Variant", () => {
		const { input, report } = parseSillyTavernChatJsonl(
			jsonl([header, emptyContent]),
			meta,
		);
		expect(input.messages?.[0]?.variants[0]?.content).toBe("");
		expect(input.messages?.[0]?.variants[0]?.timestamp).toBe(
			"2026-08-08T13:20:00.000Z",
		);
		expect(report.warnings).toEqual([]);
	});

	test("aborts on invalid JSON with the offending line number", () => {
		const source = `${JSON.stringify(header)}\n${JSON.stringify(first)}\n{"broken"`;
		expect(() => parseSillyTavernChatJsonl(source, meta)).toThrow(
			new SillyTavernImportError("Line 3 is not valid JSON."),
		);
	});

	test("aborts on an empty source", () => {
		expect(() => parseSillyTavernChatJsonl("\n\n", meta)).toThrow(
			new SillyTavernImportError("The source contains no records."),
		);
	});

	test("aborts when the first record is not an object", () => {
		const source = `[1, 2]\n${JSON.stringify(first)}`;
		expect(() => parseSillyTavernChatJsonl(source, meta)).toThrow(
			/the first record is not an object/i,
		);
	});

	test("aborts when a later record is not an object", () => {
		const source = `${JSON.stringify(header)}\n"just a string"`;
		expect(() => parseSillyTavernChatJsonl(source, meta)).toThrow(
			/Record at position 1 is not an object/,
		);
	});

	test("aborts on a message without string content", () => {
		const broken = { name: "Writer", send_date: "2026-08-08T12:53:02.008Z" };
		expect(() => parseSillyTavernChatJsonl(jsonl([header, broken]), meta)).toThrow(
			/Message at position 1 has no string content/,
		);
	});

	test("aborts on an invalid send_date", () => {
		const broken = { name: "Writer", send_date: "yesterday", mes: "hi" };
		expect(() => parseSillyTavernChatJsonl(jsonl([header, broken]), meta)).toThrow(
			/Message at position 1 has an invalid send_date/,
		);
	});

	test("aborts when the captured author name is missing or not a string", () => {
		const missingName = { send_date: "2026-08-08T12:53:02.008Z", mes: "hi" };
		expect(() =>
			parseSillyTavernChatJsonl(jsonl([header, missingName]), meta),
		).toThrow(/Message at position 1 has no captured author name/);

		const numericName = {
			name: 42,
			send_date: "2026-08-08T12:53:02.008Z",
			mes: "hi",
		};
		expect(() =>
			parseSillyTavernChatJsonl(jsonl([header, numericName]), meta),
		).toThrow(/Message at position 1 has no captured author name/);
	});

	test("derives one Variant per Swipe in source order and selects exactly swipe_id", () => {
		const { input, report } = parseSillyTavernChatJsonl(
			jsonl([header, swiped]),
			meta,
		);

		const message = input.messages?.[0];
		expect(message).toEqual({
			// Message time is the earliest timestamp among its own Variants,
			// not the row send_date (13:04:55.256Z).
			timestamp: "2026-08-08T13:04:50.000Z",
			authorParticipantIndex: 0,
			data: [
				{
					namespace: IMPORT_NAMESPACE,
					key: IMPORT_KEYS.authorName,
					value: "TANJS",
				},
			],
			variants: [
				{
					content: "First alternative text",
					timestamp: "2026-08-08T13:04:50.000Z",
					selected: false,
					data: [
						{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.swipeIndex, value: "0" },
						{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.api, value: "custom" },
						{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.model, value: "deepseek-v4-flash" },
						{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.generationId, value: "1786194665138" },
						{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.generationStarted, value: "2026-08-08T13:04:48.000Z" },
						{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.generationFinished, value: "2026-08-08T13:04:49.500Z" },
						{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.generationDuration, value: "1500" },
						{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.timeToFirstToken, value: "1235" },
						{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.finishReason, value: "stop" },
						{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.reasoningDuration, value: "25407" },
						{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.reasoningType, value: "model" },
						{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.reasoningText, value: "reasoning for the first alternative" },
						{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.reasoningSignature, value: "signature-abc" },
					],
				},
				{
					content: "Second alternative, still saved",
					timestamp: "2026-08-08T13:04:55.256Z",
					selected: true,
					data: [
						{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.swipeIndex, value: "1" },
						{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.api, value: "custom" },
						{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.model, value: "deepseek-v4-flash" },
						{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.generationId, value: "1786194665138" },
						{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.generationStarted, value: "2026-08-08T13:04:52.000Z" },
						{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.generationFinished, value: "2026-08-08T13:04:54.000Z" },
						{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.timeToFirstToken, value: "1256" },
						{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.reasoningDuration, value: "76921" },
						{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.reasoningType, value: "model" },
						{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.reasoningText, value: "reasoning for the saved alternative" },
						// reasoning_signature is null in the source: not promoted.
					],
				},
				{
					content: "Second alternative, still saved",
					timestamp: "2026-08-08T13:04:57.000Z",
					selected: false,
					data: [
						{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.swipeIndex, value: "2" },
						{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.api, value: "custom" },
						{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.model, value: "deepseek-v4-flash" },
						// Empty reasoning and null signature are not promoted.
					],
				},
				{
					content: "",
					timestamp: "2026-08-08T13:05:00.000Z",
					selected: false,
					data: [
						{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.swipeIndex, value: "3" },
						// No swipe_info extra: nothing else to promote.
					],
				},
			],
		});

		// Duplicate-text and empty Swipes stay distinct in the count.
		expect(report.counts).toEqual({ messages: 1, variants: 4 });
	});

	test("never promotes the duplicated top-level assistant payload when Swipes exist", () => {
		const { input, report } = parseSillyTavernChatJsonl(
			jsonl([header, swiped]),
			meta,
		);

		// Row-level values duplicated from the saved alternative (mes,
		// extra.api/model/gen_id, reasoning, gen_started/gen_finished) must
		// not appear anywhere in the native Message/Variant projection.
		const projection = JSON.stringify(input.messages);
		expect(projection).not.toContain("duplicate-api");
		expect(projection).not.toContain("duplicate-model");
		expect(projection).not.toContain("999999");
		expect(projection).not.toContain("duplicate reasoning");

		// The duplicated payload remains value-lossless in the raw archive.
		const archive = input.data?.find(
			(entry) =>
				entry.namespace === ARCHIVE_NAMESPACE && entry.key === ARCHIVE_KEY,
		);
		// SAFETY: archive.value was produced by JSON.stringify over the same fixture object.
		const archived = JSON.parse(archive?.value ?? "") as {
			messages: unknown[];
		};
		expect(archived.messages[0]).toEqual(swiped);

		// No duplicate-import warnings are emitted for valid Swipe state.
		expect(report.warnings).toEqual([]);
	});

	test("selects an empty Swipe when the source saved it", () => {
		const emptySelected = {
			name: "TANJS",
			is_user: false,
			send_date: "2026-08-08T13:40:00.000Z",
			mes: "",
			swipes: ["", "A nonempty alternative"],
			swipe_id: 0,
			swipe_info: [
				{ send_date: "2026-08-08T13:40:00.000Z" },
				{ send_date: "2026-08-08T13:40:05.000Z" },
			],
		};
		const { input, report } = parseSillyTavernChatJsonl(
			jsonl([header, emptySelected]),
			meta,
		);

		const variants = input.messages?.[0]?.variants ?? [];
		expect(variants).toHaveLength(2);
		expect(variants[0]?.content).toBe("");
		expect(variants[0]?.selected).toBe(true);
		expect(variants[1]?.selected).toBe(false);
		expect(input.messages?.[0]?.timestamp).toBe("2026-08-08T13:40:00.000Z");
		expect(report.warnings).toEqual([]);
	});

	test("attaches row-level provenance to a payload-only Variant", () => {
		const { input } = parseSillyTavernChatJsonl(
			jsonl([header, provenancedPayload]),
			meta,
		);

		expect(input.messages).toEqual([
			{
				timestamp: "2026-08-08T13:30:00.000Z",
				authorParticipantIndex: 0,
				data: [
					{
						namespace: IMPORT_NAMESPACE,
						key: IMPORT_KEYS.authorName,
						value: "Writer",
					},
				],
				variants: [
					{
						content: "A payload-only message with row provenance",
						timestamp: "2026-08-08T13:30:00.000Z",
						selected: true,
						data: [
							{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.api, value: "custom" },
							{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.model, value: "deepseek-v4-flash" },
							{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.generationId, value: "1786194665138" },
							{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.generationStarted, value: "2026-08-08T13:29:58.000Z" },
							{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.generationFinished, value: "2026-08-08T13:30:00.000Z" },
							{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.generationDuration, value: "2000" },
							{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.timeToFirstToken, value: "100" },
							{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.finishReason, value: "length" },
							{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.reasoningDuration, value: "500" },
							{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.reasoningType, value: "model" },
							{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.reasoningText, value: "row-level reasoning text" },
							{ namespace: IMPORT_NAMESPACE, key: VARIANT_KEYS.reasoningSignature, value: "signature-row" },
							// No swipe index: this Variant is not a Swipe.
						],
					},
				],
			},
		]);
	});

	test("aborts when swipe_info does not match the swipes array", () => {
		const mismatched = {
			name: "TANJS",
			send_date: "2026-08-08T13:04:55.256Z",
			mes: "x",
			swipes: ["a", "b"],
			swipe_id: 0,
			swipe_info: [{ send_date: "2026-08-08T13:04:55.256Z" }],
		};
		expect(() =>
			parseSillyTavernChatJsonl(jsonl([header, mismatched]), meta),
		).toThrow(/swipe_info that does not match its swipes array/);

		const missing = {
			name: "TANJS",
			send_date: "2026-08-08T13:04:55.256Z",
			mes: "x",
			swipes: ["a", "b"],
			swipe_id: 0,
		};
		expect(() =>
			parseSillyTavernChatJsonl(jsonl([header, missing]), meta),
		).toThrow(/swipe_info that does not match its swipes array/);
	});

	test("aborts on an out-of-range swipe_id", () => {
		const tooHigh = {
			name: "TANJS",
			send_date: "2026-08-08T13:04:55.256Z",
			mes: "x",
			swipes: ["a", "b"],
			swipe_id: 2,
			swipe_info: [
				{ send_date: "2026-08-08T13:04:55.256Z" },
				{ send_date: "2026-08-08T13:04:55.256Z" },
			],
		};
		expect(() =>
			parseSillyTavernChatJsonl(jsonl([header, tooHigh]), meta),
		).toThrow(/out-of-range swipe_id/);

		const negative = { ...tooHigh, swipe_id: -1 };
		expect(() =>
			parseSillyTavernChatJsonl(jsonl([header, negative]), meta),
		).toThrow(/out-of-range swipe_id/);

		const fractional = { ...tooHigh, swipe_id: 1.5 };
		expect(() =>
			parseSillyTavernChatJsonl(jsonl([header, fractional]), meta),
		).toThrow(/out-of-range swipe_id/);

		const missingId = { ...tooHigh, swipe_id: undefined };
		expect(() =>
			parseSillyTavernChatJsonl(jsonl([header, missingId]), meta),
		).toThrow(/out-of-range swipe_id/);
	});

	test("aborts on a non-string Swipe and on a non-array swipes value", () => {
		const nonStringSwipe = {
			name: "TANJS",
			send_date: "2026-08-08T13:04:55.256Z",
			mes: "x",
			swipes: ["a", 42],
			swipe_id: 0,
			swipe_info: [
				{ send_date: "2026-08-08T13:04:55.256Z" },
				{ send_date: "2026-08-08T13:04:55.256Z" },
			],
		};
		expect(() =>
			parseSillyTavernChatJsonl(jsonl([header, nonStringSwipe]), meta),
		).toThrow(/swipe 1 is not a string/);

		const nonArray = {
			name: "TANJS",
			send_date: "2026-08-08T13:04:55.256Z",
			mes: "x",
			swipes: "nope",
			swipe_id: 0,
		};
		expect(() =>
			parseSillyTavernChatJsonl(jsonl([header, nonArray]), meta),
		).toThrow(/swipes value that is not an array/);
	});

	test("aborts on invalid Swipe timestamps", () => {
		const badSendDate = {
			name: "TANJS",
			send_date: "2026-08-08T13:04:55.256Z",
			mes: "x",
			swipes: ["a"],
			swipe_id: 0,
			swipe_info: [{ send_date: "yesterday" }],
		};
		expect(() =>
			parseSillyTavernChatJsonl(jsonl([header, badSendDate]), meta),
		).toThrow(/swipe 0 send_date has an invalid timestamp/);

		const badGenStarted = {
			name: "TANJS",
			send_date: "2026-08-08T13:04:55.256Z",
			mes: "x",
			swipes: ["a"],
			swipe_id: 0,
			swipe_info: [{ send_date: "2026-08-08T13:04:55.256Z", gen_started: "soon" }],
		};
		expect(() =>
			parseSillyTavernChatJsonl(jsonl([header, badGenStarted]), meta),
		).toThrow(/swipe 0 gen_started has an invalid timestamp/);
	});
});
