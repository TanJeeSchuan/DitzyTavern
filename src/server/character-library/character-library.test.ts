import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { openDatabase } from "../database/database";
import {
	characterOpeningTable,
	characterPromptTable,
	characterTable,
} from "../database/schema";
import {
	createCharacterLibraryModule,
	CharacterNotFoundError,
	InvalidCharacterCommandError,
	InvalidCharacterDefinitionError,
	StaleCharacterRevisionError,
} from ".";
import type { CharacterDefinition } from ".";

const definition = (overrides: Partial<CharacterDefinition> = {}): CharacterDefinition => ({
	name: "Maren Voss",
	prompt: {
		systemInstruction: "You are the keeper of the Lantern House.",
		identity: "Maren is a lighthouse archivist.",
		scenario: "A storm season begins on the northern coast.",
		exampleDialogue: "<START>\n{{user}}: Who tends the light?\n{{char}}: I do.",
		postHistoryInstruction: "Keep the fog dense and the prose patient.",
	},
	openings: ["The lamp turns above you."],
	...overrides,
});

const emptyPrompt = {
	systemInstruction: "",
	identity: "",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
};

describe("Character Library", () => {
	let database: Database;
	let library: ReturnType<typeof createCharacterLibraryModule>;

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
		library = createCharacterLibraryModule(database);
	});

	afterEach(() => {
		database.close();
	});

	test("creates a Character atomically from a complete Definition and persists every field exactly", () => {
		const exact = definition({
			prompt: {
				systemInstruction: "  leading and trailing   ",
				identity: "",
				scenario: "Unicode stays: café, 灯台, 🜃.",
				exampleDialogue: "Raw\nmulti-line\n\ttext",
				postHistoryInstruction: "",
			},
			openings: [
				"First opening with trailing spaces   ",
				"First opening with trailing spaces   ",
			],
		});

		const created = library.execute({
			type: "create",
			definition: exact,
		});

		expect(created.revision).toBe(0);
		expect(created.pinned).toBe(false);
		expect(created.name).toBe(exact.name);
		expect(created.prompt).toEqual(exact.prompt);
		expect(created.openings).toEqual([
			"First opening with trailing spaces   ",
			"First opening with trailing spaces   ",
		]);

		const reread = library.get(created.id);
		expect(reread).toEqual(created);
	});

	test("creates a Character with an empty Prompt and no openings", () => {
		const created = library.execute({
			type: "create",
			definition: { name: "Blank Slate", prompt: emptyPrompt, openings: [] },
		});

		expect(created.prompt).toEqual(emptyPrompt);
		expect(created.openings).toEqual([]);
	});

	test("rejects creation from a blank name or a blank opening without partial writes", () => {
		expect(() =>
			library.execute({
				type: "create",
				definition: definition({ name: "   " }),
			}),
		).toThrow(InvalidCharacterDefinitionError);

		expect(() =>
			library.execute({
				type: "create",
				definition: definition({ openings: ["Fine", "   "] }),
			}),
		).toThrow(InvalidCharacterDefinitionError);

		const db = drizzle(database);
		expect(db.select().from(characterTable).all()).toHaveLength(0);
		expect(db.select().from(characterPromptTable).all()).toHaveLength(0);
		expect(db.select().from(characterOpeningTable).all()).toHaveLength(0);
	});

	test("trims surrounding name whitespace while preserving case and Unicode", () => {
		const created = library.execute({
			type: "create",
			definition: definition({ name: "  JUNO Åshfeld-灯台  " }),
		});

		expect(created.name).toBe("JUNO Åshfeld-灯台");
	});

	test("accepts duplicate names as independent Characters", () => {
		const first = library.execute({ type: "create", definition: definition() });
		const second = library.execute({
			type: "create",
			definition: definition({ prompt: emptyPrompt }),
		});

		expect(first.id).not.toBe(second.id);
		expect(first.name).toBe(second.name);
		const listed = library.list();
		expect(listed).toHaveLength(2);
		expect(listed.map((character) => character.id)).toEqual([first.id, second.id]);
	});

	test("sorts pinned Characters first, then alphabetically within each group", () => {
		const zebra = library.execute({
			type: "create",
			definition: definition({ name: "Zebra" }),
		});
		const alpha = library.execute({
			type: "create",
			definition: definition({ name: "Alpha" }),
		});
		const middle = library.execute({
			type: "create",
			definition: definition({ name: "MIDDLE" }),
		});
		const beta = library.execute({
			type: "create",
			definition: definition({ name: "beta" }),
		});

		library.execute({
			type: "set-pinned",
			characterId: zebra.id,
			expectedRevision: zebra.revision,
			pinned: true,
		});
		library.execute({
			type: "set-pinned",
			characterId: beta.id,
			expectedRevision: beta.revision,
			pinned: true,
		});

		expect(library.list().map((character) => character.name)).toEqual([
			"beta",
			"Zebra",
			"Alpha",
			"MIDDLE",
		]);
		expect(alpha.id).toBeLessThan(middle.id);
	});

	test("rename replaces the name through a revisioned atomic command", () => {
		const created = library.execute({ type: "create", definition: definition() });

		const renamed = library.execute({
			type: "rename",
			characterId: created.id,
			expectedRevision: created.revision,
			name: "  Renamed Voss ",
		});

		expect(renamed.name).toBe("Renamed Voss");
		expect(renamed.revision).toBe(created.revision + 1);
		expect(renamed.prompt).toEqual(created.prompt);
		expect(renamed.openings).toEqual(created.openings);
	});

	test("whole-Prompt replacement swaps every field in one atomic command", () => {
		const created = library.execute({ type: "create", definition: definition() });
		const replacement = {
			systemInstruction: "New system instruction.",
			identity: "",
			scenario: "New scenario.",
			exampleDialogue: "",
			postHistoryInstruction: "New post-history.",
		};

		const replaced = library.execute({
			type: "replace-prompt",
			characterId: created.id,
			expectedRevision: created.revision,
			prompt: replacement,
		});

		expect(replaced.prompt).toEqual(replacement);
		expect(replaced.revision).toBe(created.revision + 1);
		expect(replaced.name).toBe(created.name);
		expect(library.get(created.id)?.openings).toEqual(created.openings);
	});

	test("whole-openings replacement swaps order, duplicates, and emptiness atomically", () => {
		const created = library.execute({
			type: "create",
			definition: definition({ openings: ["Old one"] }),
		});
		const replacement = ["Second", "Second", "First"];

		const replaced = library.execute({
			type: "replace-openings",
			characterId: created.id,
			expectedRevision: created.revision,
			openings: replacement,
		});
		expect(replaced.openings).toEqual(replacement);
		expect(replaced.revision).toBe(created.revision + 1);

		const emptied = library.execute({
			type: "replace-openings",
			characterId: created.id,
			expectedRevision: replaced.revision,
			openings: [],
		});
		expect(emptied.openings).toEqual([]);
		expect(emptied.revision).toBe(replaced.revision + 1);
	});

	test("pinning and unpinning are ordinary revisioned commands", () => {
		const created = library.execute({ type: "create", definition: definition() });

		const pinned = library.execute({
			type: "set-pinned",
			characterId: created.id,
			expectedRevision: created.revision,
			pinned: true,
		});
		expect(pinned.pinned).toBe(true);
		expect(pinned.revision).toBe(created.revision + 1);

		const unpinned = library.execute({
			type: "set-pinned",
			characterId: created.id,
			expectedRevision: pinned.revision,
			pinned: false,
		});
		expect(unpinned.pinned).toBe(false);
		expect(unpinned.revision).toBe(pinned.revision + 1);
	});

	test("a stale command fails with a typed conflict carrying the authoritative Character and changes nothing", () => {
		const created = library.execute({ type: "create", definition: definition() });
		const advanced = library.execute({
			type: "rename",
			characterId: created.id,
			expectedRevision: created.revision,
			name: "Authoritative Name",
		});

		let conflict: StaleCharacterRevisionError | undefined;
		try {
			library.execute({
				type: "replace-openings",
				characterId: created.id,
				expectedRevision: created.revision,
				openings: ["Stale draft opening"],
			});
		} catch (error) {
			if (error instanceof StaleCharacterRevisionError) {
				conflict = error;
			}
		}

		expect(conflict).toBeDefined();
		expect(conflict?.expectedRevision).toBe(created.revision);
		expect(conflict?.actualRevision).toBe(advanced.revision);
		expect(conflict?.currentCharacter).toEqual(advanced);

		const reread = library.get(created.id);
		expect(reread).toEqual(advanced);
		expect(reread?.openings).toEqual(["The lamp turns above you."]);
	});

	test("every mutation rejects a tombstoned Character as not found", () => {
		const created = library.execute({ type: "create", definition: definition() });

		const db = drizzle(database);
		db.update(characterTable)
			.set({ deleted_at: new Date().toISOString() })
			.where(eq(characterTable.id, created.id))
			.run();

		expect(library.get(created.id)).toBeUndefined();
		expect(library.list().map((character) => character.id)).not.toContain(
			created.id,
		);
		for (const command of [
			{
				type: "rename" as const,
				characterId: created.id,
				expectedRevision: 0,
				name: "Ghost",
			},
			{
				type: "set-pinned" as const,
				characterId: created.id,
				expectedRevision: 0,
				pinned: true,
			},
		]) {
			expect(() => library.execute(command)).toThrow(CharacterNotFoundError);
		}
	});

	test("commands on missing Characters report not found", () => {
		expect(() =>
			library.execute({
				type: "rename",
				characterId: 424242,
				expectedRevision: 0,
				name: "Nobody",
			}),
		).toThrow(CharacterNotFoundError);
	});

	test("command validation failures reject blank names and blank openings without advancing revisions", () => {
		const created = library.execute({ type: "create", definition: definition() });

		expect(() =>
			library.execute({
				type: "rename",
				characterId: created.id,
				expectedRevision: created.revision,
				name: " \t ",
			}),
		).toThrow(InvalidCharacterCommandError);
		expect(() =>
			library.execute({
				type: "replace-openings",
				characterId: created.id,
				expectedRevision: created.revision,
				openings: ["\n"],
			}),
		).toThrow(InvalidCharacterCommandError);

		expect(library.get(created.id)?.revision).toBe(created.revision);
	});

	test("structural constraints back the domain: ordered unique openings and enforced foreign keys", () => {
		const created = library.execute({
			type: "create",
			definition: definition({ openings: ["One", "Two"] }),
		});

		const db = drizzle(database);
		expect(() =>
			db
				.insert(characterOpeningTable)
				.values({ character_id: created.id, position: 2, content: "Clash" })
				.run(),
		).toThrow();

		expect(() =>
			db
				.insert(characterPromptTable)
				.values({
					character_id: 987654,
					system_instruction: "",
					identity: "",
					scenario: "",
					example_dialogue: "",
					post_history_instruction: "",
				})
				.run(),
		).toThrow();
	});
});
