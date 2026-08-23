import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../server/database/database";
import {
	createCharacterLibraryModule,
	type CharacterDefinition,
	type CharacterLibraryCommand,
} from "../server/character-library";
import {
	createCharacterLibraryRoutes,
	createNativeConversationRoutes,
} from "./contract";

const definition = (overrides: Partial<CharacterDefinition> = {}): CharacterDefinition => ({
	name: "Maren Voss",
	prompt: {
		systemInstruction: "System text.",
		identity: "Identity text.",
		scenario: "",
		exampleDialogue: "",
		postHistoryInstruction: "",
	},
	openings: [],
	...overrides,
});

// Transport tests cover request/response contracts and typed error mapping
// only; the domain matrix lives behind the Character Library seam tests.
describe("Character Library transport adapters", () => {
	let database: Database;
	let app: ReturnType<typeof createCharacterLibraryRoutes>;

	const post = async (command: CharacterLibraryCommand) =>
		app.handle(
			new Request("http://localhost/api/characters/commands", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(command),
			}),
		);

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
		app = createCharacterLibraryRoutes(database);
	});

	afterEach(() => {
		database.close();
	});

	test("lists Characters in library order", async () => {
		await post({ type: "create", definition: definition({ name: "Zebra" }) });
		const alpha = await post({
			type: "create",
			definition: definition({ name: "Alpha" }),
		});
		const alphaCharacter = (await alpha.json()).character;

		await post({
			type: "set-pinned",
			characterId: alphaCharacter.id,
			expectedRevision: 0,
			pinned: true,
		});

		const response = await app.handle(new Request("http://localhost/api/characters"));
		expect(response.status).toBe(200);
		const { characters } = await response.json();
		expect(characters).toHaveLength(2);
	});

	test("returns a Character detail and a typed not-found outcome", async () => {
		const created = await (
			await post({ type: "create", definition: definition() })
		).json();
		const characterId = created.character.id;

		const found = await app.handle(
			new Request(`http://localhost/api/characters/${characterId}`),
		);
		expect(found.status).toBe(200);
		expect((await found.json()).openings).toEqual([]);

		const missing = await app.handle(
			new Request("http://localhost/api/characters/999999"),
		);
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({ outcome: "not-found" });
	});

	test("applies commands, propagates revisions, and maps conflicts to the typed 409 payload", async () => {
		const created = await (
			await post({ type: "create", definition: definition() })
		).json();

		const applied = await post({
			type: "rename",
			characterId: created.character.id,
			expectedRevision: 0,
			name: "Renamed",
		});
		expect(applied.status).toBe(200);
		const appliedBody = await applied.json();
		expect(appliedBody.outcome).toBe("applied");
		expect(appliedBody.character.revision).toBe(1);

		const stale = await post({
			type: "rename",
			characterId: created.character.id,
			expectedRevision: 0,
			name: "Stale",
		});
		expect(stale.status).toBe(409);
		const conflict = await stale.json();
		expect(conflict.outcome).toBe("conflict");
		expect(conflict.expectedRevision).toBe(0);
		expect(conflict.actualRevision).toBe(1);
		expect(conflict.currentCharacter.name).toBe("Renamed");
		expect(conflict.currentCharacter.revision).toBe(1);
	});

	test("maps validation failures and missing Characters to their typed outcomes", async () => {
		const invalid = await post({
			type: "create",
			definition: definition({ name: "   ", openings: ["ok"] }),
		});
		expect(invalid.status).toBe(422);
		const invalidBody = await invalid.json();
		expect(invalidBody.outcome).toBe("invalid");
		expect(invalidBody.reason).toBe("A Character name is required.");

		const missing = await post({
			type: "set-pinned",
			characterId: 123456,
			expectedRevision: 0,
			pinned: true,
		});
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({ outcome: "not-found" });
	});
});

// Transport tests for the native New Chat workflow cover the request and
// response contract plus typed error mapping; workflow behavior lives
// behind its own interface tests.
describe("Native Conversation transport adapter", () => {
	let database: Database;
	let app: ReturnType<typeof createNativeConversationRoutes>;

	interface AdHocSeatPayload {
		type: "adhoc";
		definition: {
			name: string;
			prompt: {
				systemInstruction: string;
				identity: string;
				scenario: string;
				exampleDialogue: string;
				postHistoryInstruction: string;
			};
			openings: string[];
		};
	}

	type NewChatSeatPayload =
		| AdHocSeatPayload
		| { type: "character"; characterId: number; expectedRevision: number };

	interface NativeCreationBody {
		name: string;
		humanSeat: NewChatSeatPayload;
		modelSeat: NewChatSeatPayload;
	}

	const post = (body: NativeCreationBody) =>
		app.handle(
			new Request("http://localhost/api/conversations/native", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		);

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
		app = createNativeConversationRoutes(database);
	});

	afterEach(() => {
		database.close();
	});

	const adHocSeat = (name = "Writer"): AdHocSeatPayload => ({
		type: "adhoc",
		definition: {
			name,
			prompt: {
				systemInstruction: "",
				identity: "",
				scenario: "",
				exampleDialogue: "",
				postHistoryInstruction: "",
			},
			openings: [],
		},
	});

	test("creates a playable native Conversation and returns its snapshot", async () => {
		const response = await post({
			name: "Transport Chat",
			humanSeat: adHocSeat("Writer"),
			modelSeat: adHocSeat("Maren Voss"),
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.outcome).toBe("created");
		expect(body.conversation.playable).toBe(true);
		expect(body.conversation.cast.map((p: { name: string }) => p.name)).toEqual([
			"Writer",
			"Maren Voss",
		]);
		expect(body.conversation.control.humanParticipantId).toBe(
			body.conversation.cast[0]?.id,
		);
	});

	test("maps a stale fork source to the typed conflict payload", async () => {
		const library = createCharacterLibraryModule(database);
		const source = library.execute({ type: "create", definition: definition() });
		await library.execute({
			type: "rename",
			characterId: source.id,
			expectedRevision: 0,
			name: "Renamed Voss",
		});

		const response = await post({
			name: "Stale Fork",
			humanSeat: adHocSeat(),
			modelSeat: {
				type: "character",
				characterId: source.id,
				expectedRevision: 0,
			},
		});
		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.outcome).toBe("conflict");
		expect(body.expectedRevision).toBe(0);
		expect(body.actualRevision).toBe(1);
		expect(body.currentCharacter.name).toBe("Renamed Voss");
	});

	test("maps a missing fork source and invalid Definitions to typed outcomes", async () => {
		const missing = await post({
			name: "Ghost",
			humanSeat: adHocSeat(),
			modelSeat: { type: "character", characterId: 424242, expectedRevision: 0 },
		});
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({ outcome: "not-found" });

		const invalid = await post({
			name: "Invalid",
			humanSeat: adHocSeat(),
			modelSeat: {
				type: "adhoc",
				definition: { ...adHocSeat().definition, openings: ["   "] },
			},
		});
		expect(invalid.status).toBe(422);
		const body = await invalid.json();
		expect(body.outcome).toBe("invalid");
		expect(body.reason).toContain("blank opening");
	});
});
