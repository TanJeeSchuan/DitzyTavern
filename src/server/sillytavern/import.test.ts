import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { openDatabase } from "../database/database";
import {
	chatDataTable,
	chatTable,
	messageTable,
	messageVariantTable,
} from "../database/schema";
import {
	ARCHIVE_KEY,
	ARCHIVE_NAMESPACE,
	IMPORT_KEYS,
	IMPORT_NAMESPACE,
	IMPORTER_VERSION,
	importSillyTavernChat,
} from "./index";
import { SillyTavernImportError } from "./errors";
import type { SillyTavernImportReport } from "./adapter";
import { createConversationModule } from "../conversation";
import {
	blankNameFixture as blankName,
	headerFixture as header,
	jsonl,
	rulershipFixture as second,
	writerFixture as first,
} from "./fixtures";

const findEntry = (
	entries: { namespace: string; key: string; value: string }[] | undefined,
	namespace: string,
	key: string,
) => entries?.find((entry) => entry.namespace === namespace && entry.key === key);

describe("SillyTavern chat import", () => {
	let database: Database;
	let files: string[];

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
		const directory = mkdtempSync(join(tmpdir(), "ditzytavern-import-"));
		files = [directory];
	});
	afterEach(() => {
		database.close();
		for (const path of files) rmSync(path, { recursive: true, force: true });
	});

	const writeSource = (records: unknown[], filename = "lantern-house.jsonl") => {
		const path = join(files[0] ?? "", filename);
		writeFileSync(path, jsonl(records), "utf8");
		return path;
	};

	const sha256Of = (records: unknown[]) =>
		createHash("sha256")
			.update(Buffer.from(jsonl(records), "utf8"))
			.digest("hex");

	const countRows = (table: typeof chatTable | typeof messageTable | typeof messageVariantTable | typeof chatDataTable) =>
		drizzle(database).select().from(table).all().length;

	test("imports a payload-only JSONL file end to end through the creation seam", () => {
		const path = writeSource([header, first, second, blankName]);
		const result = importSillyTavernChat(database, path);
		const conversation = result.conversation;

		// The Chat takes its temporary name from the filename stem.
		expect(conversation.name).toBe("lantern-house");
		expect(conversation.revision).toBe(0);
		expect(conversation.characterIds).toEqual([]);
		expect(conversation.messages).toHaveLength(3);
		expect(conversation.messages.map((message) => message.position)).toEqual([
			1, 2, 3,
		]);
		expect(
			conversation.messages[2]?.variants[0]?.content,
		).toBe("🔥 Wait, truly?");
		expect(conversation.messages[0]?.data).toEqual([
			{
				namespace: IMPORT_NAMESPACE,
				key: IMPORT_KEYS.authorName,
				value: "Writer",
			},
		]);

		// Chat and activity times are derived from the mapped timestamps.
		const chatRow = drizzle(database)
			.select()
			.from(chatTable)
			.where(eq(chatTable.id, conversation.id))
			.get();
		expect(chatRow?.creation_time).toBe("2026-08-08T12:53:02.008Z");
		expect(chatRow?.last_message_time).toBe("2026-08-08T13:10:00.000Z");

		// The canonical archive round-trips the entire parsed source.
		const archive = findEntry(
			conversation.data,
			ARCHIVE_NAMESPACE,
			ARCHIVE_KEY,
		);
		expect(JSON.parse(archive?.value ?? "")).toEqual({
			header,
			messages: [first, second, blankName],
		});

		// Source identity, counts, importer version, warnings, and the JSON
		// report remain separate entries in the transitional import namespace.
		const sha256 = sha256Of([header, first, second, blankName]);
		expect(
			findEntry(conversation.data, IMPORT_NAMESPACE, IMPORT_KEYS.sha256)
				?.value,
		).toBe(sha256);
		expect(
			findEntry(conversation.data, IMPORT_NAMESPACE, IMPORT_KEYS.integrity)
				?.value,
		).toBe("9543f21f-8aab-42c8-92a4-1f6453d4b63c");
		expect(
			findEntry(conversation.data, IMPORT_NAMESPACE, IMPORT_KEYS.filename)
				?.value,
		).toBe("lantern-house.jsonl");
		expect(
			findEntry(conversation.data, IMPORT_NAMESPACE, IMPORT_KEYS.importerVersion)
				?.value,
		).toBe(IMPORTER_VERSION);
		expect(
			findEntry(conversation.data, IMPORT_NAMESPACE, IMPORT_KEYS.countsMessages)
				?.value,
		).toBe("3");
		expect(
			findEntry(conversation.data, IMPORT_NAMESPACE, IMPORT_KEYS.countsVariants)
				?.value,
		).toBe("3");
		expect(
			JSON.parse(
				findEntry(conversation.data, IMPORT_NAMESPACE, IMPORT_KEYS.warnings)
					?.value ?? "",
			),
		).toEqual([
			"Message at position 3 has a blank captured author name.",
		]);
		expect(
			JSON.parse(
				findEntry(conversation.data, IMPORT_NAMESPACE, IMPORT_KEYS.reportJson)
					?.value ?? "",
			),
		).toEqual(result.report);

		// The result is readable through the public snapshot seam.
		expect(
			createConversationModule(database).getSnapshot(conversation.id),
		).toEqual(conversation);
	});

	test("allows re-importing the same source as an independent Chat with a warning", () => {
		const path = writeSource([header, first, second]);
		const firstImport = importSillyTavernChat(database, path);
		const secondImport = importSillyTavernChat(database, path);

		expect(secondImport.conversation.id).not.toBe(firstImport.conversation.id);
		expect(secondImport.duplicateChatIds).toEqual([firstImport.conversation.id]);
		expect(secondImport.report.warnings).toEqual([
			`Source was already imported as chat ${firstImport.conversation.id} ("lantern-house"); this import creates an independent copy.`,
		]);
		expect(firstImport.report.warnings).toEqual([]);
		expect(
			findEntry(
				firstImport.conversation.data,
				IMPORT_NAMESPACE,
				IMPORT_KEYS.sha256,
			)?.value,
		).toBe(
			findEntry(
				secondImport.conversation.data,
				IMPORT_NAMESPACE,
				IMPORT_KEYS.sha256,
			)?.value,
		);
	});

	test("aborts the whole import atomically on a structural defect", () => {
		const path = writeSource([header, first, '{"broken"', second]);
		expect(() => importSillyTavernChat(database, path)).toThrow(
			SillyTavernImportError,
		);
		expect(countRows(chatTable)).toBe(0);
		expect(countRows(messageTable)).toBe(0);
		expect(countRows(messageVariantTable)).toBe(0);
		expect(countRows(chatDataTable)).toBe(0);
	});

	test("rejects a missing source file", () => {
		expect(() =>
			importSillyTavernChat(database, join(files[0] ?? "", "missing.jsonl")),
		).toThrow(/Could not read/);
	});

	test("rejects a source that is not valid UTF-8", () => {
		const path = join(files[0] ?? "", "binary.jsonl");
		writeFileSync(path, Buffer.from([0xc3, 0x28, 0x0a]));
		expect(() => importSillyTavernChat(database, path)).toThrow(
			/The source is not valid UTF-8/,
		);
	});

	test("derives a chat name that is the filename stem", () => {
		const path = writeSource([header, first], "archive-2026-08-08.jsonl");
		const { conversation, report } = importSillyTavernChat(database, path);
		expect(conversation.name).toBe("archive-2026-08-08");
		expect(report.source.filename).toBe("archive-2026-08-08.jsonl");
	});

	test("stores the full JSON report with the conversation", () => {
		const path = writeSource([header, first, blankName]);
		const { conversation, report } = importSillyTavernChat(database, path);
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