import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { openInitializedDatabase } from "../database/database";
import {
	conversationDataTable,
	conversationTable,
	messageTable,
	messageVariantTable,
} from "../database/schema";
import { importSillyTavernChat } from "./index";
import { SillyTavernImportError } from "./errors";
import {
	headerFixture as header,
	jsonl,
	rulershipFixture as second,
	writerFixture as first,
} from "./fixtures";

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
			| typeof conversationDataTable,
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

	test("rejects a missing source file", () => {
		expect(() =>
			importChat(join(files[0] ?? "", "missing.jsonl")),
		).toThrow(/Could not read/);
	});
});
