import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { openInitializedDatabase } from "../database/database";
import {
	artifactTable,
	conversationDataTable,
	conversationTable,
	messageTable,
	messageVariantTable,
	participantTable,
} from "../database/schema";
import {
	IMPORT_KEYS,
	IMPORT_NAMESPACE,
	importSillyTavernChat,
} from "./index";
import { SillyTavernImportError } from "./errors";
import type { SillyTavernImportReport } from "./adapter";
import {
	blankNameFixture as blankName,
	headerFixture as header,
	jsonl,
	rulershipFixture as second,
	swipeRecordFixture as swiped,
	writerFixture as first,
} from "./fixtures";

const findEntry = (
	entries: { namespace: string; key: string; value: string }[] | undefined,
	namespace: string,
	key: string,
) => entries?.find((entry) => entry.namespace === namespace && entry.key === key);

describe("SillyTavern import validation", () => {
	let database: Database;
	let files: string[];
	let artifactDirectory: string;

	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
		const directory = mkdtempSync(join(tmpdir(), "ditzytavern-import-"));
		files = [directory];
		artifactDirectory = join(directory, "managed-artifacts");
	});
	afterEach(() => {
		database.close();
		for (const path of files) rmSync(path, { recursive: true, force: true });
	});

	// Every import call in these tests preserves the exact source bytes in
	// an isolated managed artifact directory, through the same public
	// signature the developer command uses.
	const importChat = (sourcePath: string) =>
		importSillyTavernChat(database, sourcePath, artifactDirectory);

	const writeSource = (records: unknown[], filename = "lantern-house.jsonl") => {
		const path = join(files[0] ?? "", filename);
		writeFileSync(path, jsonl(records), "utf8");
		return path;
	};

	const countRows = (
		table:
			| typeof conversationTable
			| typeof messageTable
			| typeof messageVariantTable
			| typeof conversationDataTable
			| typeof artifactTable
			| typeof participantTable,
	) => drizzle(database).select().from(table).all().length;

	test("aborts the whole import atomically on a structural defect", () => {
		const path = writeSource([header, first, '{"broken"', second]);
		expect(() => importChat(path)).toThrow(
			SillyTavernImportError,
		);
		expect(countRows(conversationTable)).toBe(0);
		expect(countRows(messageTable)).toBe(0);
		expect(countRows(messageVariantTable)).toBe(0);
		expect(countRows(conversationDataTable)).toBe(0);
	});

	test("aborts the whole import atomically on a mismatched Swipe array", () => {
		const broken = {
			name: "TANJS",
			send_date: "2026-08-08T13:04:55.256Z",
			mes: "x",
			swipes: ["a", "b"],
			swipe_id: 0,
			swipe_info: [{ send_date: "2026-08-08T13:04:55.256Z" }],
		};
		const path = writeSource([header, swiped, broken]);
		expect(() => importChat(path)).toThrow(
			SillyTavernImportError,
		);
		expect(countRows(conversationTable)).toBe(0);
		expect(countRows(messageTable)).toBe(0);
		expect(countRows(messageVariantTable)).toBe(0);
		expect(countRows(conversationDataTable)).toBe(0);
	});

	test("rejects a missing source file", () => {
		expect(() =>
			importChat(join(files[0] ?? "", "missing.jsonl")),
		).toThrow(/Could not read/);
	});

	test("rejects a source that is not valid UTF-8", () => {
		const path = join(files[0] ?? "", "binary.jsonl");
		writeFileSync(path, Buffer.from([0xc3, 0x28, 0x0a]));
		expect(() => importChat(path)).toThrow(
			/The source is not valid UTF-8/,
		);
	});

	test("derives a chat name that is the filename stem", () => {
		const path = writeSource([header, first], "archive-2026-08-08.jsonl");
		const { conversation, report } = importChat(path);
		expect(conversation.name).toBe("archive-2026-08-08");
		expect(report.source.filename).toBe("archive-2026-08-08.jsonl");
	});

	test("stores the full JSON report with the conversation", () => {
		const path = writeSource([header, first, blankName]);
		const { conversation, report } = importChat(path);
		// SAFETY: reportJson.value was serialized from the same report we compare against.
		const stored = JSON.parse(
			findEntry(
				conversation.data,
				IMPORT_NAMESPACE,
				IMPORT_KEYS.reportJson,
			)?.value ?? "",
		) as SillyTavernImportReport;
		expect(stored).toEqual(report);
		expect(stored.counts).toEqual({ messages: 2, variants: 2 });
		expect(stored.warnings).toHaveLength(1);
		expect(stored.warnings[0]).toContain("blank captured author name");
		expect(stored.source.integrity).toBe("9543f21f-8aab-42c8-92a4-1f6453d4b63c");
	});


});
