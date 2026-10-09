import { readTestConversationSnapshot } from "../test-fixtures/conversation";
import { executeConversationCommand } from "../conversation";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	conversationTable,
	participantTable,
} from "../database/schema";
import { openInitializedDatabase } from "../database/database";
import {
	createCharacterLibraryModule,
	CharacterNotFoundError,
} from "../character-library";
import { StaleRevisionError } from "../revision";
import type { CharacterDefinition } from "../character-library";
import { ConversationNotFoundError, type ConversationSummary } from "../conversation";
import { requireSnapshot } from "../test-fixtures/conversation";
import { addCharacterToCast, createNativeConversation } from ".";

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

describe("Add Character to Cast workflow", () => {
	let database: Database;

	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
	});
	afterEach(() => {
		database.close();
	});

	const countRows = (table: typeof conversationTable | typeof participantTable) =>
		drizzle(database).select().from(table).all().length;

	const playableConversation = () =>
		createNativeConversation(database, {
			name: "Host Chat",
			humanSeat: {
				type: "adhoc",
				definition: { name: "Writer", prompt: prompt(), openings: [] },
			},
			modelSeat: {
				type: "adhoc",
				definition: { name: "Juno Ashfeld", prompt: prompt(), openings: [] },
			},
		});

	test("forks a Character into the Cast with provenance and the authoritative Definition", () => {
		const library = createCharacterLibraryModule(database);
		const source = library.execute({
			type: "create",
			definition: sourceDefinition(),
		});
		const conversation = playableConversation();

		const messagesBefore = requireSnapshot(database, conversation.id).messages;
		const updated = addCharacterToCast(database, {
			conversationId: conversation.id,
			expectedConversationRevision: conversation.revision,
			characterId: source.id,
			expectedCharacterRevision: source.revision,
		});

		const added = updated.cast.at(-1);
		expect(added?.name).toBe(source.name);
		expect(added?.prompt).toEqual(source.prompt);
		expect(added?.openings).toEqual(source.openings);
		expect(added?.sourceCharacterId).toBe(source.id);
		expect(added?.position).toBe(3);
		expect(updated.revision).toBe(conversation.revision + 1);
		// Adding a Character never inserts history or changes Control.
		expect(
			requireSnapshot(database, conversation.id).messages,
		).toEqual(messagesBefore);
		expect(updated.control).toEqual(conversation.control);
	});

	test("allows the same Character to be forked repeatedly into one Cast", () => {
		const library = createCharacterLibraryModule(database);
		const source = library.execute({
			type: "create",
			definition: sourceDefinition({ name: "Twins" }),
		});
		let conversation: ConversationSummary = playableConversation();

		for (const expectedRevision of [source.revision, source.revision]) {
			conversation = addCharacterToCast(database, {
				conversationId: conversation.id,
				expectedConversationRevision: conversation.revision,
				characterId: source.id,
				expectedCharacterRevision: expectedRevision,
			});
		}

		const forks = conversation.cast.filter(
			(participant) => participant.sourceCharacterId === source.id,
		);
		expect(forks).toHaveLength(2);
		expect(forks[0]?.id).not.toBe(forks[1]?.id);
	});

	test("a stale source Character revision fails with the typed conflict and commits nothing", () => {
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
		const conversation = playableConversation();

		let conflict: StaleRevisionError | undefined;
		try {
			addCharacterToCast(database, {
				conversationId: conversation.id,
				expectedConversationRevision: conversation.revision,
				characterId: source.id,
				expectedCharacterRevision: source.revision,
			});
		} catch (error) {
			if (error instanceof StaleRevisionError) conflict = error;
		}

		expect(conflict).toBeDefined();
		expect(conflict?.expectedRevision).toBe(source.revision);
		expect(conflict?.actualRevision).toBe(advanced.revision);
		// SAFETY: the stale conflict's character aggregate always carries the
		// authoritative current Character snapshot.
		expect((conflict?.current as { name: string } | undefined)?.name).toBe("Renamed Voss");
		// Atomic: no Participant rows were appended.
		expect(countRows(participantTable)).toBe(2);
		expect(
			readTestConversationSnapshot(database, conversation.id)?.revision,
		).toBe(conversation.revision);
	});

	test("a stale destination Conversation revision fails atomically", () => {
		const library = createCharacterLibraryModule(database);
		const source = library.execute({
			type: "create",
			definition: sourceDefinition(),
		});
		let conversation: ConversationSummary = playableConversation();
		conversation = executeConversationCommand(database, {
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			action: {
				type: "add-participant",
				definition: { name: "Concurrent", prompt: prompt(), openings: [] },
			},
		});

		let conflict: StaleRevisionError | undefined;
		try {
			addCharacterToCast(database, {
				conversationId: conversation.id,
				expectedConversationRevision: conversation.revision - 1,
				characterId: source.id,
				expectedCharacterRevision: source.revision,
			});
		} catch (error) {
			if (error instanceof StaleRevisionError) conflict = error;
		}

		expect(conflict).toBeDefined();
		expect(conflict?.expectedRevision).toBe(conversation.revision - 1);
		expect(conflict?.actualRevision).toBe(conversation.revision);
		// No fork was appended and the revision did not advance again.
		expect(
			readTestConversationSnapshot(database, conversation.id)?.cast,
		).toHaveLength(3);
	});

	test("a missing destination Conversation fails as not found without partial writes", () => {
		const library = createCharacterLibraryModule(database);
		const source = library.execute({
			type: "create",
			definition: sourceDefinition(),
		});
		const conversation = playableConversation();

		expect(() =>
			addCharacterToCast(database, {
				conversationId: 424242,
				expectedConversationRevision: 0,
				characterId: source.id,
				expectedCharacterRevision: source.revision,
			}),
		).toThrow(ConversationNotFoundError);
		// The existing Conversation and its Cast are untouched.
		expect(countRows(conversationTable)).toBe(1);
		expect(
			readTestConversationSnapshot(database, conversation.id)?.revision,
		).toBe(conversation.revision);
		expect(countRows(participantTable)).toBe(2);
	});

	test("a missing fork source fails as not found without partial writes", () => {
		const conversation = playableConversation();
		expect(() =>
			addCharacterToCast(database, {
				conversationId: conversation.id,
				expectedConversationRevision: conversation.revision,
				characterId: 123456,
				expectedCharacterRevision: 0,
			}),
		).toThrow(CharacterNotFoundError);
		expect(countRows(participantTable)).toBe(2);
	});

	test("a tombstoned Character cannot create new forks", () => {
		const library = createCharacterLibraryModule(database);
		const source = library.execute({
			type: "create",
			definition: sourceDefinition(),
		});
		const conversation = playableConversation();
		// The fork below keeps the source referenced, so deletion reduces it
		// to a hidden tombstone rather than hard-deleting the row.
		addCharacterToCast(database, {
			conversationId: conversation.id,
			expectedConversationRevision: conversation.revision,
			characterId: source.id,
			expectedCharacterRevision: source.revision,
		});
		library.execute({
			type: "delete",
			characterId: source.id,
			expectedRevision: source.revision,
		});

		const snapshot = readTestConversationSnapshot(database,
			conversation.id,
		);
		if (snapshot === undefined) {
			throw new Error("Expected the host Conversation");
		}
		expect(() =>
			addCharacterToCast(database, {
				conversationId: conversation.id,
				expectedConversationRevision: snapshot.revision,
				characterId: source.id,
				expectedCharacterRevision: source.revision,
			}),
		).toThrow(CharacterNotFoundError);
		// Atomically nothing changed: no additional Participant fork exists.
		expect(countRows(participantTable)).toBe(3);
		expect(
			readTestConversationSnapshot(database, conversation.id)?.revision,
		).toBe(snapshot.revision);
	});

	test("later independent edits to Character and Participant never resync", () => {
		const library = createCharacterLibraryModule(database);
		const source = library.execute({
			type: "create",
			definition: sourceDefinition(),
		});
		const conversation = playableConversation();
		const updated = addCharacterToCast(database, {
			conversationId: conversation.id,
			expectedConversationRevision: conversation.revision,
			characterId: source.id,
			expectedCharacterRevision: source.revision,
		});
		const forkId = updated.cast.at(-1)?.id ?? 0;

		library.execute({
			type: "replace-openings",
			characterId: source.id,
			expectedRevision: source.revision,
			openings: ["Rewritten source opening"],
		});
		const edited = executeConversationCommand(database, {
			conversationId: conversation.id,
			expectedRevision: updated.revision,
			action: {
				type: "rename-participant",
				participantId: forkId,
				name: "Local Maren",
			},
		});

		const rereadSource = library.get(source.id);
		expect(rereadSource?.openings).toEqual(["Rewritten source opening"]);
		expect(rereadSource?.name).toBe("Maren Voss");
		expect(edited.cast.at(-1)?.name).toBe("Local Maren");
		expect(edited.cast.at(-1)?.openings).toEqual([
			"The lamp turns above you.",
			"Rain writes on every window.",
		]);
		expect(edited.cast.at(-1)?.sourceCharacterId).toBe(source.id);
	});
});
