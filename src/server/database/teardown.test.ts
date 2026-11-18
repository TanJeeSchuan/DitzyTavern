import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createCharacterLibraryModule } from "../character-library";
import { openInitializedDatabase } from "./database";
import { characterTable, conversationTable } from "./schema";
import { createConversationWithHistory } from "../test-fixtures/conversation";
import { characters, seed } from "./seed";
import { teardown } from "./teardown";

describe("Database seed and teardown", () => {
	let directory: string;
	let databasePath: string;

	beforeEach(() => {
		mkdirSync(".scratch", { recursive: true });
		directory = mkdtempSync(join(".scratch", "ditzytavern-teardown-"));
		databasePath = join(directory, "test.sqlite");
	});

	afterEach(() => {
		try {
			rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		} catch {}
	});

	test("teardown removes seeded rows while preserving user-created characters", () => {
		seed(databasePath);

		const database = openInitializedDatabase({ path: databasePath });
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
						appearance: "",
						scenario: "Traveling through uncharted lands.",
						exampleDialogue: "",
						postHistoryInstruction: "",
					},
					sendAppearanceImages: true,
					openings: ["Hello, traveler."],
				},
			});

			const charactersBefore = db.select().from(characterTable).all();
			expect(charactersBefore.length).toBe(seededCharacters.length + 1);
		} finally {
			database.close();
		}

		teardown(databasePath);

		const afterDb = openInitializedDatabase({ path: databasePath });
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

		const finalDb = openInitializedDatabase({ path: databasePath });
		const finalDrizzle = drizzle(finalDb);

		try {
			const finalCharacters = finalDrizzle.select().from(characterTable).all();
			expect(finalCharacters).toHaveLength(1);
			expect(finalCharacters[0]?.name).toBe("User Custom Character");
		} finally {
			finalDb.close();
		}
	});
	test("teardown preserves a user Chat fork and its seeded Character provenance", () => {
		seed(databasePath);
		const database = openInitializedDatabase({ path: databasePath });
		let chatId: number;
		let sourceId: number;
		try {
			const source = createCharacterLibraryModule(database).list()[0]!;
			const character = createCharacterLibraryModule(database).get(source.id)!;
			sourceId = character.id;
			chatId = createConversationWithHistory(database, {
				name: "User fork", participants: [{ definition: character, sourceCharacterId: character.id }],
			}).id;
		} finally { database.close(); }
		teardown(databasePath);
		teardown(databasePath);
		const after = openInitializedDatabase({ path: databasePath });
		try {
			expect(createCharacterLibraryModule(after).get(sourceId)).toBeUndefined();
			expect(after.query("SELECT name, source_character_id FROM participant WHERE conversation_id = ?").get(chatId))
				.toMatchObject({ source_character_id: sourceId });
			expect(after.query("SELECT deleted_at FROM character WHERE id = ?").get(sourceId)).toMatchObject({ deleted_at: expect.any(String) });
			expect(after.query("SELECT name FROM conversation WHERE id = ?").get(chatId)).toEqual({ name: "User fork" });
		} finally { after.close(); }
		seed(databasePath);
		seed(databasePath);
		const reseeded = openInitializedDatabase({ path: databasePath });
		try {
			expect(createCharacterLibraryModule(reseeded).list()).toHaveLength(characters.length);
			expect(reseeded.query("SELECT source_character_id FROM participant WHERE conversation_id = ?").get(chatId))
				.toEqual({ source_character_id: sourceId });
		} finally { reseeded.close(); }
	});

});
