import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { chatTable, characterTable, messageTable, messageVariantTable } from "../database/schema";
import { openDatabase } from "../database/database";
import { createConversationModule, InvalidConversationCreationError } from ".";
import type { ConversationCreationInput } from ".";

const completeInput = (characterIds: readonly number[]): ConversationCreationInput => ({
	name: "Imported Conversation",
	characterIds,
	data: [{ namespace: "archive", key: "source", value: "chat-export.json" }],
	messages: [
		{
			timestamp: "2026-08-20T10:00:00Z",
			data: [{ namespace: "author", key: "name", value: "Maren" }],
			variants: [
				{
					content: "First alternative",
					timestamp: "2026-08-20T09:59:00Z",
					selected: false,
					data: [{ namespace: "generation", key: "model", value: "alpha" }],
				},
				{
					content: "Second alternative",
					timestamp: "2026-08-20T10:00:00Z",
					selected: true,
				},
			],
		},
		{
			timestamp: "2026-08-20T11:00:00Z",
			variants: [
				{
					content: "Reply",
					timestamp: "2026-08-20T11:00:00Z",
					selected: true,
				},
			],
		},
	],
});

describe("Conversation creation", () => {
	let database: Database;

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
	});
	afterEach(() => {
		database.close();
	});

	const countRows = (table: typeof chatTable | typeof messageTable | typeof messageVariantTable) =>
		drizzle(database).select().from(table).all().length;

	test("creates a complete Conversation at revision zero and returns its snapshot", () => {
		const db = drizzle(database);
		const insertedIds = db
			.insert(characterTable)
			.values([{ name: "Maren" }, { name: "Juno" }])
			.returning({ id: characterTable.id })
			.all()
			.map((row) => row.id);

		const conversation = createConversationModule(database);
		const snapshot = conversation.create(completeInput(insertedIds));

		expect(snapshot.revision).toBe(0);
		expect(snapshot.name).toBe("Imported Conversation");
		expect(snapshot.characterIds).toEqual([...insertedIds].sort((a, b) => a - b));
		expect(snapshot.data).toEqual([
			{ namespace: "archive", key: "source", value: "chat-export.json" },
		]);

		expect(snapshot.messages.map((message) => message.position)).toEqual([1, 2]);
		const [first, second] = snapshot.messages;
		expect(first?.timestamp).toBe("2026-08-20T10:00:00Z");
		expect(first?.data).toEqual([
			{ namespace: "author", key: "name", value: "Maren" },
		]);
		expect(first?.variants.map((variant) => variant.position)).toEqual([1, 2]);
		expect(first?.variants[0]).toEqual({
			id: first?.variants[0]?.id,
			position: 1,
			content: "First alternative",
			timestamp: "2026-08-20T09:59:00Z",
			selected: false,
			data: [{ namespace: "generation", key: "model", value: "alpha" }],
		});
		expect(first?.variants[1]?.selected).toBe(true);
		expect(second?.variants[0]?.content).toBe("Reply");
		expect(second?.variants[0]?.timestamp).toBe("2026-08-20T11:00:00Z");

		expect(conversation.getSnapshot(snapshot.id)).toEqual(snapshot);
	});

	test("rejects a Message with no Variants without leaving partial data", () => {
		const conversation = createConversationModule(database);
		expect(() =>
			conversation.create({
				name: "Broken",
				messages: [
					{
						timestamp: "2026-08-20T10:00:00Z",
						variants: [
							{ content: "Kept", timestamp: "2026-08-20T10:00:00Z", selected: true },
						],
					},
					{ timestamp: "2026-08-20T11:00:00Z", variants: [] },
				],
			}),
		).toThrow(InvalidConversationCreationError);
		expect(countRows(chatTable)).toBe(0);
		expect(countRows(messageTable)).toBe(0);
		expect(countRows(messageVariantTable)).toBe(0);
	});

	test("rejects a Message with no selected Variant", () => {
		const conversation = createConversationModule(database);
		expect(() =>
			conversation.create({
				name: "Broken",
				messages: [
					{
						timestamp: "2026-08-20T10:00:00Z",
						variants: [
							{ content: "A", timestamp: "2026-08-20T10:00:00Z", selected: false },
							{ content: "B", timestamp: "2026-08-20T10:01:00Z", selected: false },
						],
					},
				],
			}),
		).toThrow(InvalidConversationCreationError);
		expect(countRows(chatTable)).toBe(0);
	});

	test("rejects a Message with more than one selected Variant", () => {
		const conversation = createConversationModule(database);
		expect(() =>
			conversation.create({
				name: "Broken",
				messages: [
					{
						timestamp: "2026-08-20T10:00:00Z",
						variants: [
							{ content: "A", timestamp: "2026-08-20T10:00:00Z", selected: true },
							{ content: "B", timestamp: "2026-08-20T10:01:00Z", selected: true },
						],
					},
				],
			}),
		).toThrow(InvalidConversationCreationError);
		expect(countRows(chatTable)).toBe(0);
	});

	test("rejects a Conversation whose referenced Character does not exist", () => {
		const conversation = createConversationModule(database);
		expect(() =>
			conversation.create({ name: "Broken", characterIds: [404] }),
		).toThrow(InvalidConversationCreationError);
		expect(countRows(chatTable)).toBe(0);
	});

	test("creates an empty Conversation that starts with no history", () => {
		const conversation = createConversationModule(database);
		const snapshot = conversation.create({ name: "Empty" });
		expect(snapshot.revision).toBe(0);
		expect(snapshot.messages).toEqual([]);
		expect(snapshot.characterIds).toEqual([]);
		expect(snapshot.data).toEqual([]);
	});
});
