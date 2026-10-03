import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createCharacterLibraryModule, InvalidCharacterCommandError } from "../character-library";
import { createConversationModule, deleteConversation, InvalidConversationCommandError } from "../conversation";
import { createConversationRoutes } from "../contract/conversation";
import { base64, pngFixture } from "../image/image-fixtures";
import { ingestUploads } from "../image";
import type { Portrait } from "../../shared/contract/image";
import { addCharacterToCast, createNativeConversation, saveParticipantAsCharacter } from ".";

const prompt = {
	systemInstruction: "",
	identity: "A lighthouse archivist.",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
};

const art = async (width: number): Promise<{ portrait: Portrait; pool: Awaited<ReturnType<typeof ingestUploads>> }> => {
	const pool = await ingestUploads([base64(pngFixture({ width }))]);
	const [hash] = [...pool.keys()];
	if (hash === undefined) throw new Error("fixture produced no image");
	return { portrait: { hash, focalX: 0.25, focalY: 0.75 }, pool };
};

describe("Portraits", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => { database.close(); });

	const imageHashes = () => database.query<{ hash: string }, []>("SELECT hash FROM image").all().map((row) => row.hash);
	const library = () => createCharacterLibraryModule(database);
	const conversations = () => createConversationModule(database);

	const writer = { name: "Writer", prompt, openings: [] };

	const seatConversation = (characterId: number, expectedRevision: number) =>
		createNativeConversation(database, {
			name: "Chat",
			humanSeat: { type: "adhoc", definition: writer },
			modelSeat: { type: "character", characterId, expectedRevision },
		});

	test("stores identical uploads as one Image and drops it with its last reference", async () => {
		const first = await art(4);
		const a = library().execute({ type: "create", definition: { name: "A", prompt, openings: [], portrait: first.portrait } }, first.pool);
		const b = library().execute({ type: "create", definition: { name: "B", prompt, openings: [], portrait: first.portrait } }, first.pool);
		expect(imageHashes()).toEqual([first.portrait.hash]);

		library().execute({ type: "update-definition", characterId: a.id, expectedRevision: a.revision, definition: { name: "A", prompt, openings: [] } });
		expect(imageHashes()).toEqual([first.portrait.hash]);

		library().execute({ type: "delete", characterId: b.id, expectedRevision: b.revision });
		expect(imageHashes()).toEqual([]);
	});

	test("replacing a Portrait keeps the new Image and drops the old one", async () => {
		const [old, next] = [await art(4), await art(5)];
		const character = library().execute({ type: "create", definition: { name: "A", prompt, openings: [], portrait: old.portrait } }, old.pool);
		const updated = library().execute(
			{ type: "update-definition", characterId: character.id, expectedRevision: character.revision, definition: { name: "A", prompt, openings: [], portrait: next.portrait } },
			next.pool,
		);
		expect(updated.portrait).toEqual(next.portrait);
		expect(imageHashes()).toEqual([next.portrait.hash]);
	});

	test("a failed command leaves neither an Image nor a reference", async () => {
		const carried = await art(4);
		expect(() => library().execute({ type: "create", definition: { name: "A", prompt, openings: [" "], portrait: carried.portrait } }, carried.pool)).toThrow();
		expect(() => library().execute({ type: "create", definition: { name: "A", prompt, openings: [], portrait: carried.portrait } })).toThrow(InvalidCharacterCommandError);
		expect(library().list()).toEqual([]);
		expect(imageHashes()).toEqual([]);

		const chat = conversations().create({ name: "Chat", participants: [{ definition: writer }, { definition: { ...writer, name: "Maren" } }], control: { human: 0, model: 1 } });
		expect(() => conversations().execute({
			conversationId: chat.id,
			expectedRevision: chat.revision,
			action: { type: "add-participant", definition: { name: "Ghost", prompt, openings: [], portrait: carried.portrait } },
		})).toThrow(InvalidConversationCommandError);
		expect(conversations().getSummary(chat.id)?.cast).toHaveLength(2);
		expect(imageHashes()).toEqual([]);
	});

	test("seeding copies the Portrait and later Character edits leave the Chat unchanged", async () => {
		const [original, replacement] = [await art(4), await art(5)];
		const character = library().execute({ type: "create", definition: { name: "Maren", prompt, openings: [], portrait: original.portrait } }, original.pool);
		const chat = seatConversation(character.id, character.revision);
		expect(chat.cast[1]?.portrait).toEqual(original.portrait);

		library().execute(
			{ type: "update-definition", characterId: character.id, expectedRevision: character.revision, definition: { name: "Maren", prompt, openings: [], portrait: replacement.portrait } },
			replacement.pool,
		);
		expect(conversations().getSummary(chat.id)?.cast[1]?.portrait).toEqual(original.portrait);
		expect(imageHashes().sort()).toEqual([original.portrait.hash, replacement.portrait.hash].sort());
	});

	test("adding a Character to the Cast copies its Portrait", async () => {
		const carried = await art(4);
		const character = library().execute({ type: "create", definition: { name: "Maren", prompt, openings: [], portrait: carried.portrait } }, carried.pool);
		const chat = conversations().create({ name: "Chat", participants: [{ definition: writer }, { definition: { ...writer, name: "Other" } }], control: { human: 0, model: 1 } });
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
			images: carried.pool,
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
		const character = library().execute({ type: "create", definition: { name: "Maren", prompt, openings: [], portrait: carried.portrait } }, carried.pool);
		const chat = seatConversation(character.id, character.revision);

		const result = library().execute({ type: "delete", characterId: character.id, expectedRevision: character.revision });
		expect(result.deletionMode).toBe("tombstone");
		expect(imageHashes()).toEqual([carried.portrait.hash]);

		deleteConversation(database, chat.id);
		expect(imageHashes()).toEqual([]);
	});

	test("a removed Participant's Messages fall back to the stamped name and its Portrait is dropped", async () => {
		const carried = await art(4);
		const chat = conversations().create({
			name: "Chat",
			images: carried.pool,
			participants: [{ definition: writer }, { definition: { ...writer, name: "Maren" } }, { definition: { ...writer, name: "Guest", portrait: carried.portrait } }],
			control: { human: 0, model: 1 },
			messages: [{ timestamp: "2026-09-13T00:00:00.000Z", authorParticipantIndex: 2, variants: [{ content: "Hello", timestamp: "2026-09-13T00:00:00.000Z", selected: true }] }],
		});
		const guest = chat.cast[2];
		if (guest === undefined) throw new Error("Guest missing");
		expect(imageHashes()).toEqual([carried.portrait.hash]);

		const removed = conversations().execute({ conversationId: chat.id, expectedRevision: chat.revision, action: { type: "remove-participant", participantId: guest.id } });
		expect(removed.cast.map((participant) => participant.name)).toEqual(["Writer", "Maren"]);
		expect(imageHashes()).toEqual([]);
		const message = conversations().getSnapshot(chat.id)?.messages[0];
		expect(message?.author).toMatchObject({ capturedName: "Guest", inCast: false });
	});

	test("a Portrait never enters a Prompt Plan", async () => {
		const carried = await art(4);
		const chat = conversations().create({
			name: "Chat",
			images: carried.pool,
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
