import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { processStateFor } from "../application/process-state";
import { openInitializedDatabase } from "../database/database";
import {
	conversationDataTable,
	conversationTable,
	messageTable,
	messageVariantTable,
} from "../database/schema";
import { importChatFixture } from "../test-fixtures/chat-import";
import { SillyTavernImportError } from "./errors";
import { headerFixture as header, jsonl, rulershipFixture as second, writerFixture as first } from "./fixtures";
import { createChatImportModule, type ChatImportModule } from "./staged";

describe("SillyTavern import validation", () => {
	let database: Database;
	let directory: string;
	let module: ChatImportModule;

	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
		directory = mkdtempSync(join(tmpdir(), "ditzytavern-import-"));
		module = createChatImportModule(database, { artifactDirectory: directory });
	});
	afterEach(() => {
		processStateFor(database).dispose();
		database.close();
		rmSync(directory, { recursive: true, force: true });
	});

	test("aborts the whole import atomically on a structural defect", async () => {
		const source = jsonl([header, first, '{"broken"', second]);
		await expect(importChatFixture(module, source)).rejects.toThrow(SillyTavernImportError);
		const db = drizzle(database);
		expect(db.select().from(conversationTable).all()).toHaveLength(0);
		expect(db.select().from(messageTable).all()).toHaveLength(0);
		expect(db.select().from(messageVariantTable).all()).toHaveLength(0);
		expect(db.select().from(conversationDataTable).all()).toHaveLength(0);
		expect(readdirSync(directory)).toEqual([]);
	});
});
