import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	conversationTable,
	conversationControlTable,
	messageTable,
	messageVariantTable,
	participantPromptTable,
	participantTable,
} from "../database/schema";
import { openDatabase } from "../database/database";
import {
	createCharacterLibraryModule,
	CharacterNotFoundError,
	StaleCharacterRevisionError,
} from "../character-library";
import type { CharacterDefinition } from "../character-library";
import { createNativeConversation } from ".";

const prompt = () => ({
	systemInstruction: "Keep the scene grounded.",
	identity: "Lighthouse archivist on the northern coast.",
	scenario: "A storm season begins.",
	exampleDialogue: "<START>\n{{user}}: Who tends the light?",
	postHistoryInstruction: "",
});

const sourceDefinition = (overrides: Partial<CharacterDefinition> = {}): CharacterDefinition => ({
	name: "Maren Voss",
	prompt: prompt(),
	openings: ["The lamp turns above you.", "Rain writes on every window."],
	...overrides,
});

describe("Native New Chat workflow", () => {
	let database: Database;

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
	});
	afterEach(() => {
		database.close();
	});

	const countRows = (
		table:
			| typeof conversationTable
			| typeof messageTable
			| typeof messageVariantTable
			| typeof participantTable
			| typeof participantPromptTable
			| typeof conversationControlTable,
	) => drizzle(database).select().from(table).all().length;

	const fork = (characterId: number, expectedRevision: number) => ({
		type: "character" as const,
		characterId,
		expectedRevision,
	});
	const adHoc = (name: string, openings: string[] = []) => ({
		type: "adhoc" as const,
		definition: { name, prompt: prompt(), openings },
	});

	test("creates a playable Conversation from two ad-hoc Participants atomically", () => {
		const snapshot = createNativeConversation(database, {
			name: "Ad-hoc Chat",
			humanSeat: adHoc("Writer"),
			modelSeat: adHoc("Juno Ashfeld", ["The workshop bell rings twice."]),
		});

		const [human, model] = snapshot.cast;
		expect(snapshot.playable).toBe(true);
		expect(human?.name).toBe("Writer");
		expect(model?.name).toBe("Juno Ashfeld");
		expect(human?.id).not.toBe(model?.id);
		expect(snapshot.control).toEqual({
			humanParticipantId: human?.id,
			modelParticipantId: model?.id,
		});
		expect(snapshot.messages[0]?.variants[0]?.content).toBe(
			"The workshop bell rings twice.",
		);

		// The whole Conversation commits at revision zero with no other rows.
		expect(snapshot.revision).toBe(0);
		expect(countRows(conversationTable)).toBe(1);
		expect(countRows(participantTable)).toBe(2);
	});

	test("forks copy the authoritative Definition server-side and record provenance without revisions or synchronization", () => {
		const library = createCharacterLibraryModule(database);
		const source = library.execute({
			type: "create",
			definition: sourceDefinition(),
		});

		const snapshot = createNativeConversation(database, {
			name: "Forked Chat",
			humanSeat: adHoc("Writer"),
			modelSeat: fork(source.id, source.revision),
		});

		const model = snapshot.cast[1];
		expect(model?.sourceCharacterId).toBe(source.id);
		expect(model?.prompt).toEqual(source.prompt);
		expect(model?.openings).toEqual(["The lamp turns above you.", "Rain writes on every window."]);

		// The Cast snapshot carries full copied Definitions and immutable
		// provenance only; there is no revision or live link to the source.
		// (Fork independence from later source edits is pinned at the
		// Conversation creation seam tests.)
		expect(JSON.stringify(Object.keys(model ?? {}))).not.toContain("revision");
	});

	test("forks two different Characters into the two seats with distinct Definitions", () => {
		const library = createCharacterLibraryModule(database);
		const humanSource = library.execute({
			type: "create",
			definition: sourceDefinition({
				name: "Iris Vale",
				openings: ["Human openings never become history."],
			}),
		});
		const modelSource = library.execute({
			type: "create",
			definition: sourceDefinition({
				name: "Bram Okafor",
				prompt: {
					...prompt(),
					identity: "Night radio operator on the headland.",
				},
				openings: ["Static clears, then a voice."],
			}),
		});

		const snapshot = createNativeConversation(database, {
			name: "Two Sources",
			humanSeat: fork(humanSource.id, humanSource.revision),
			modelSeat: fork(modelSource.id, modelSource.revision),
		});

		const [human, model] = snapshot.cast;
		expect(human?.name).toBe("Iris Vale");
		expect(model?.name).toBe("Bram Okafor");
		expect(human?.sourceCharacterId).toBe(humanSource.id);
		expect(model?.sourceCharacterId).toBe(modelSource.id);
		expect(human?.id).not.toBe(model?.id);
		// Each seat carries its own source's complete Definition copy.
		expect(model?.prompt.identity).toBe("Night radio operator on the headland.");
		expect(human?.openings).toEqual(["Human openings never become history."]);
		// Greeting history comes only from the model seat's fork.
		expect(snapshot.messages).toHaveLength(1);
		expect(snapshot.messages[0]?.variants.map((variant) => variant.content)).toEqual([
			"Static clears, then a voice.",
		]);
		expect(snapshot.messages[0]?.author?.participantId).toBe(model?.id);
	});

	test("a stale Character revision fails with a typed conflict and commits nothing", () => {
		const library = createCharacterLibraryModule(database);
		const source = library.execute({
			type: "create",
			definition: sourceDefinition(),
		});
		const advanced = library.execute({
			type: "rename",
			characterId: source.id,
			expectedRevision: source.revision,
			name: "Renamed Voss",
		});

		let conflict: StaleCharacterRevisionError | undefined;
		try {
			createNativeConversation(database, {
				name: "Stale Fork",
				humanSeat: adHoc("Writer"),
				modelSeat: fork(source.id, 0),
			});
		} catch (error) {
			if (error instanceof StaleCharacterRevisionError) conflict = error;
		}

		expect(conflict).toBeDefined();
		expect(conflict?.expectedRevision).toBe(0);
		expect(conflict?.actualRevision).toBe(advanced.revision);
		expect(conflict?.currentCharacter.name).toBe("Renamed Voss");

		// Atomic: no Conversation, Participants, Control, or greeting exist.
		expect(countRows(conversationTable)).toBe(0);
		expect(countRows(participantTable)).toBe(0);
		expect(countRows(participantPromptTable)).toBe(0);
		expect(countRows(conversationControlTable)).toBe(0);
		expect(countRows(messageTable)).toBe(0);
		expect(countRows(messageVariantTable)).toBe(0);
	});

	test("a missing fork source fails as not found without partial writes", () => {
		expect(() =>
			createNativeConversation(database, {
				name: "Ghost Fork",
				humanSeat: adHoc("Writer"),
				modelSeat: fork(424242, 0),
			}),
		).toThrow(CharacterNotFoundError);
		expect(countRows(conversationTable)).toBe(0);
		expect(countRows(participantTable)).toBe(0);
	});
});
