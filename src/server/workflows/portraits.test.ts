import { createConversation, executeConversationCommand, readConversationSummary, readConversationSnapshot } from "../conversation";
import { openObservedDatabase } from "../test-fixtures/conversation";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createCharacterLibraryModule } from "../character-library";
import { deleteConversation } from "../conversation";
import { createConversationRoutes } from "../contract/conversation";
import { pngFixture } from "../image/image-fixtures";
import { uploadImage, sweepOrphanedImages, InvalidImageError } from "../image";
import type { Portrait } from "../../shared/contract/image";
import { addCharacterToCast, createNativeConversation, saveParticipantAsCharacter } from ".";

const prompt = {
	systemInstruction: "",
	identity: "A lighthouse archivist.",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
};

describe("Portraits", () => {
	let database: Database;

	beforeEach(() => {
		database = openObservedDatabase();
	});
	afterEach(() => { database.close(); });

	const art = async (width: number): Promise<{ portrait: Portrait }> => {
		const { hash } = await uploadImage(database, pngFixture({ width }));
		return { portrait: { hash, focalX: 0.25, focalY: 0.75 } };
	};
	const referenced = () => { sweepOrphanedImages(database); return database.query<{ hash: string }, []>("SELECT hash FROM image WHERE orphaned_at IS NULL").all().map((row) => row.hash); };
	const library = () => createCharacterLibraryModule(database);
	const conversations = () => database;

	const writer = { name: "Writer", prompt, openings: [] };

	const seatConversation = (characterId: number, expectedRevision: number) =>
		createNativeConversation(database, {
			name: "Chat",
			humanSeat: { type: "adhoc", definition: writer },
			modelSeat: { type: "character", characterId, expectedRevision },
		});

	test("stores identical uploads as one Image and orphans it with its last reference", async () => {
		const first = await art(4);
		const a = library().execute({ type: "create", definition: { name: "A", prompt, openings: [], portrait: first.portrait } });
		const b = library().execute({ type: "create", definition: { name: "B", prompt, openings: [], portrait: first.portrait } });
		expect(referenced()).toEqual([first.portrait.hash]);

		library().execute({ type: "update-definition", characterId: a.id, expectedRevision: a.revision, definition: { name: "A", prompt, openings: [] } });
		expect(referenced()).toEqual([first.portrait.hash]);

		library().execute({ type: "delete", characterId: b.id, expectedRevision: b.revision });
		expect(referenced()).toEqual([]);
	});

	test("replacing a Portrait keeps the new Image and orphans the old one", async () => {
		const [old, next] = [await art(4), await art(5)];
		const character = library().execute({ type: "create", definition: { name: "A", prompt, openings: [], portrait: old.portrait } });
		const updated = library().execute(
			{ type: "update-definition", characterId: character.id, expectedRevision: character.revision, definition: { name: "A", prompt, openings: [], portrait: next.portrait } },
		);
		expect(updated.portrait).toEqual(next.portrait);
		expect(referenced()).toEqual([next.portrait.hash]);
	});

	test("a failed command leaves its upload orphaned; unknown Portrait hashes are rejected", async () => {
		const carried = await art(4);
		expect(() => library().execute({ type: "create", definition: { name: "A", prompt, openings: [" "], portrait: carried.portrait } })).toThrow();
		expect(() => library().execute({ type: "create", definition: { name: "A", prompt, openings: [], portrait: { ...carried.portrait, hash: "f".repeat(64) } } })).toThrow(InvalidImageError);
		expect(library().list()).toEqual([]);
		expect(referenced()).toEqual([]);

		const chat = createConversation(conversations(), { authorNote: "", name: "Chat", participants: [{ definition: writer }, { definition: { ...writer, name: "Maren" } }], control: { human: 0, model: 1 } });
		expect(() => executeConversationCommand(conversations(), {
			conversationId: chat.id,
			expectedRevision: chat.revision,
			action: { type: "add-participant", definition: { name: "Ghost", prompt, openings: [], portrait: { ...carried.portrait, hash: "f".repeat(64) } } },
		})).toThrow(InvalidImageError);
		expect(readConversationSummary(conversations(), chat.id)?.cast).toHaveLength(2);
		expect(referenced()).toEqual([]);
	});

	test("seeding copies the Portrait and later Character edits leave the Chat unchanged", async () => {
		const [original, replacement] = [await art(4), await art(5)];
		const character = library().execute({ type: "create", definition: { name: "Maren", prompt, openings: [], portrait: original.portrait } });
		const chat = seatConversation(character.id, character.revision);
		expect(chat.cast[1]?.portrait).toEqual(original.portrait);

		library().execute(
			{ type: "update-definition", characterId: character.id, expectedRevision: character.revision, definition: { name: "Maren", prompt, openings: [], portrait: replacement.portrait } },
		);
		expect(readConversationSummary(conversations(), chat.id)?.cast[1]?.portrait).toEqual(original.portrait);
		expect(referenced().sort()).toEqual([original.portrait.hash, replacement.portrait.hash].sort());
	});

	test("adding a Character to the Cast copies its Portrait", async () => {
		const carried = await art(4);
		const character = library().execute({ type: "create", definition: { name: "Maren", prompt, openings: [], portrait: carried.portrait } });
		const chat = createConversation(conversations(), { authorNote: "", name: "Chat", participants: [{ definition: writer }, { definition: { ...writer, name: "Other" } }], control: { human: 0, model: 1 } });
		const added = addCharacterToCast(database, {
			conversationId: chat.id,
			expectedConversationRevision: chat.revision,
			characterId: character.id,
			expectedCharacterRevision: character.revision,
		});
		expect(added.cast[2]?.portrait).toEqual(carried.portrait);
	});

	test("Save as Character carries an ad-hoc Participant's Portrait back", async () => {
		const carried = await art(4);
		const chat = createNativeConversation(database, {
			name: "Chat",
			humanSeat: { type: "adhoc", definition: { ...writer, portrait: carried.portrait } },
			modelSeat: { type: "adhoc", definition: { ...writer, name: "Maren" } },
		});
		const { character } = saveParticipantAsCharacter(database, {
			conversationId: chat.id,
			expectedConversationRevision: chat.revision,
			participantId: chat.cast[0]?.id ?? 0,
		});
		expect(character.portrait).toEqual(carried.portrait);
		expect(library().list()[0]?.portrait).toEqual(carried.portrait);
	});

	test("a Participant keeps the Image after its Character is deleted, and the Chat's deletion releases it", async () => {
		const carried = await art(4);
		const character = library().execute({ type: "create", definition: { name: "Maren", prompt, openings: [], portrait: carried.portrait } });
		const chat = seatConversation(character.id, character.revision);

		const result = library().execute({ type: "delete", characterId: character.id, expectedRevision: character.revision });
		expect(result.deletionMode).toBe("tombstone");
		expect(referenced()).toEqual([carried.portrait.hash]);

		deleteConversation(database, chat.id);
		expect(referenced()).toEqual([]);
	});

	test("a removed Participant's Messages fall back to the stamped name and its Portrait is orphaned", async () => {
		const carried = await art(4);
		const chat = createConversation(conversations(), {
			name: "Chat",
			participants: [{ definition: writer }, { definition: { ...writer, name: "Maren" } }, { definition: { ...writer, name: "Guest", portrait: carried.portrait } }],
			control: { human: 0, model: 1 },
			messages: [{ timestamp: "2026-09-13T00:00:00.000Z", authorParticipantIndex: 2, variants: [{ content: "Hello", timestamp: "2026-09-13T00:00:00.000Z", selected: true }] }],
		});
		const guest = chat.cast[2];
		if (guest === undefined) throw new Error("Guest missing");
		expect(referenced()).toEqual([carried.portrait.hash]);

		const removed = executeConversationCommand(conversations(), { conversationId: chat.id, expectedRevision: chat.revision, action: { type: "remove-participant", participantId: guest.id } });
		expect(removed.cast.map((participant) => participant.name)).toEqual(["Writer", "Maren"]);
		expect(referenced()).toEqual([]);
		const message = readConversationSnapshot(conversations(), chat.id)?.messages[0];
		expect(message?.author).toMatchObject({ capturedName: "Guest", inCast: false });
	});

	test("a Portrait never enters a Prompt Plan", async () => {
		const carried = await art(4);
		const chat = createConversation(conversations(), {
			name: "Chat",
			participants: [{ definition: { ...writer, portrait: carried.portrait } }, { definition: { ...writer, name: "Maren", portrait: carried.portrait } }],
			control: { human: 0, model: 1 },
		});
		const response = await createConversationRoutes(database).handle(new Request(
			`http://localhost/api/conversations/${chat.id}/generations/preview`,
			{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "send", content: "hello" }) },
		));
		expect(response.status).toBe(200);
		expect(JSON.stringify(await response.json())).not.toContain(carried.portrait.hash);
	});
});
