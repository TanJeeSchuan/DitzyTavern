import { describe, expect, test } from "bun:test";
import {
	ARCHIVE_KEY,
	ARCHIVE_NAMESPACE,
	IMPORT_KEYS,
	IMPORT_NAMESPACE,
	IMPORTER_VERSION,
	parseSillyTavernChatJsonl,
} from "./adapter";
import type { SillyTavernImportMeta } from "./adapter";
import { SillyTavernImportError } from "./errors";
import {
	blankNameFixture as blankName,
	emptyContentFixture as emptyContent,
	headerFixture as header,
	jsonl,
	rulershipFixture as second,
	writerFixture as first,
} from "./fixtures";

const meta: SillyTavernImportMeta = {
	name: "lantern-house",
	filename: "lantern-house.jsonl",
	sha256: "0f5c3e0a9d0c8f5b3a9e4d6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6",
};

describe("SillyTavern JSONL adapter", () => {
	test("maps a header and payload-only records into a generic creation input", () => {
		const { input } = parseSillyTavernChatJsonl(
			jsonl([header, first, second, blankName]),
			meta,
		);

		expect(input.name).toBe("lantern-house");
		expect(input.characterIds).toBeUndefined();
		expect(input.messages).toEqual([
			{
				timestamp: "2026-08-08T12:53:02.008Z",
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
});