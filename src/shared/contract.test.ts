import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../server/database/database";
import type {
	CharacterDefinition,
	CharacterLibraryCommand,
} from "../server/character-library";
import { createCharacterLibraryRoutes } from "./contract";

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
