import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createCharacterLibraryModule } from "../character-library";
import { openDatabase } from "./database";
import { characterTable, conversationTable } from "./schema";
import { seed } from "./seed";
import { teardown } from "./teardown";

describe("Database seed and teardown", () => {
	let directory: string;
	let databasePath: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "ditzytavern-teardown-"));
		databasePath = join(directory, "test.sqlite");
	});

	afterEach(() => {
		try {
			rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		} catch {}
	});

	test("teardown removes seeded rows while preserving user-created characters", () => {
		seed(databasePath);

		const database = openDatabase({ path: databasePath });
		const db = drizzle(database);
		const library = createCharacterLibraryModule(database);

		try {
			const seededCharacters = db.select().from(characterTable).all();
			const seededConversations = db.select().from(conversationTable).all();
			expect(seededCharacters.length).toBeGreaterThan(0);
			expect(seededConversations.length).toBeGreaterThan(0);

			library.execute({
				type: "create",
				definition: {
					name: "User Custom Character",
					prompt: {
						systemInstruction: "Custom system instruction",
						identity: "A unique wanderer.",
						scenario: "Traveling through uncharted lands.",
						exampleDialogue: "",
						postHistoryInstruction: "",
					},
					openings: ["Hello, traveler."],
				},
			});

			const charactersBefore = db.select().from(characterTable).all();
			expect(charactersBefore.length).toBe(seededCharacters.length + 1);
		} finally {
			database.close();
		}

		teardown(databasePath);

		const afterDb = openDatabase({ path: databasePath });
		const afterDrizzle = drizzle(afterDb);

		try {
			const remainingConversations = afterDrizzle.select().from(conversationTable).all();
			expect(remainingConversations).toHaveLength(0);

			const remainingCharacters = afterDrizzle.select().from(characterTable).all();
			expect(remainingCharacters).toHaveLength(1);
			expect(remainingCharacters[0]?.name).toBe("User Custom Character");
		} finally {
			afterDb.close();
		}

		teardown(databasePath);

		const finalDb = openDatabase({ path: databasePath });
		const finalDrizzle = drizzle(finalDb);

		try {
			const finalCharacters = finalDrizzle.select().from(characterTable).all();
			expect(finalCharacters).toHaveLength(1);
			expect(finalCharacters[0]?.name).toBe("User Custom Character");
		} finally {
			finalDb.close();
		}
	});
});
