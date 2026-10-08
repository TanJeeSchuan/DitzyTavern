import { requireSnapshot } from "../test-fixtures/conversation";
import { readTestConversationSnapshot } from "../test-fixtures/conversation";
import { executeConversationCommand } from "../conversation";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	characterTable,
	participantPromptTable,
	participantTable,
} from "../database/schema";
import { openInitializedDatabase } from "../database/database";
import {
	createCharacterLibraryModule,
	InvalidCharacterDefinitionError,
} from "../character-library";
import type { CharacterDefinition } from "../character-library";
import { ConversationNotFoundError, ParticipantNotFoundError, StaleConversationRevisionError } from "../conversation";
import { createNativeConversation, saveParticipantAsCharacter } from ".";

const prompt = () => ({
	systemInstruction: "Keep responses literary and patient.",
	identity: "A lighthouse archivist who catalogues shipwrecks.",
	scenario: "A storm season cuts the lantern house off from town.",
	exampleDialogue: "<START>\n{{user}}: Who tends the light?\n{{char}}: I do.",
	postHistoryInstruction: "End with a weather detail.",
});

// The saved Definition must match the Participant's stored Definition bit
// for bit: surrounding name whitespace is already normalized by the
// Conversation domain, Prompt text is exact (including blanks), and
// openings preserve their order and duplicates.
const participantDefinition = (overrides: Partial<CharacterDefinition> = {}): CharacterDefinition => ({
	name: "  Maren Voss  ",
	prompt: prompt(),
	openings: [
		"The lamp turns above you, steady as a heartbeat.",
		"The lamp turns above you, steady as a heartbeat.",
		"Rain writes on every window of the archive.",
	],
	...overrides,
});

describe("Save Participant as Character workflow", () => {
	let database: Database;

	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
	});
	afterEach(() => {
		database.close();
	});

	const countRows = (table: typeof characterTable | typeof participantTable) =>
		drizzle(database).select().from(table).all().length;

	// A playable Conversation whose model seat carries the full Definition
	// under test; the human seat is an ordinary ad-hoc Writer.
	const conversationWithDefinition = (
		overrides: Partial<CharacterDefinition> = {},
	) => {
		const definition = participantDefinition(overrides);
		return {
			conversation: createNativeConversation(database, {
				name: "Host Chat",
				humanSeat: {
					type: "adhoc",
					definition: { name: "Writer", prompt: prompt(), openings: [] },
				},
				modelSeat: { type: "adhoc", definition },
			}),
			definition,
		};
	};

	test("copies the Participant's exact Definition into one new Character atomically", () => {
		const { conversation, definition } = conversationWithDefinition();
		const participant = conversation.cast.at(-1);
		if (participant === undefined) throw new Error("Expected a model seat.");

		const result = saveParticipantAsCharacter(database, {
			conversationId: conversation.id,
			expectedConversationRevision: conversation.revision,
			participantId: participant.id,
		});

		// Definition copy is exact: normalized nonblank name, every Prompt
		// field (including blanks) byte-for-byte, and openings in order with
		// duplicates intact.
		expect(result.character.name).toBe(participant.name);
		expect(result.character.name).toBe("Maren Voss");
		expect(result.character.prompt).toEqual(definition.prompt);
		expect(result.character.openings).toEqual(definition.openings);

		// One new Character row, nothing else touched.
		const library = createCharacterLibraryModule(database);
		expect(library.list()).toHaveLength(1);
		expect(library.get(result.character.id)?.revision).toBe(0);

		// The Conversation and its revision are untouched by saving.
		const reread = readTestConversationSnapshot(database, conversation.id);
		expect(reread?.revision).toBe(conversation.revision);
		expect(reread?.cast).toEqual(conversation.cast);
		expect(reread?.messages).toEqual(requireSnapshot(database, conversation.id).messages);
	});

	test("creates a new Character even when another Character already has the same name", () => {
		const library = createCharacterLibraryModule(database);
		const existing = library.execute({
			type: "create",
			definition: {
				name: "Maren Voss",
				prompt: prompt(),
				openings: ["An opening only the existing Character had."],
			},
		});
		const { conversation } = conversationWithDefinition();
		const participant = conversation.cast.at(-1);
		if (participant === undefined) throw new Error("Expected a model seat.");

		const result = saveParticipantAsCharacter(database, {
			conversationId: conversation.id,
			expectedConversationRevision: conversation.revision,
			participantId: participant.id,
		});

		expect(result.character.id).not.toBe(existing.id);
		const sameName = library
			.list()
			.filter((character) => character.name === "Maren Voss");
		expect(sameName).toHaveLength(2);
		// The new Character carries the Participant's Definition, not the
		// existing library Character's.
		expect(result.character.openings).toEqual(
			participantDefinition().openings,
		);
		expect(library.get(existing.id)?.openings).toEqual([
			"An opening only the existing Character had.",
		]);
	});

	test("leaves an ad-hoc Participant unchanged with no provenance", () => {
		const { conversation } = conversationWithDefinition();
		const participant = conversation.cast.at(-1);
		if (participant === undefined) throw new Error("Expected a model seat.");
		expect(participant.sourceCharacterId).toBeNull();

		saveParticipantAsCharacter(database, {
			conversationId: conversation.id,
			expectedConversationRevision: conversation.revision,
			participantId: participant.id,
		});

		const reread = readTestConversationSnapshot(database, conversation.id);
		const saved = reread?.cast.find((entry) => entry.id === participant.id);
		// The original Participant and this Conversation did not change: same
		// position, local Definition, no provenance, and the same revision.
		expect(saved).toEqual(participant);
		expect(saved?.sourceCharacterId).toBeNull();
		expect(reread?.revision).toBe(conversation.revision);
		expect(countRows(participantTable)).toBe(2);
	});

	test("keeps a forked Participant's immutable provenance when saving", () => {
		const library = createCharacterLibraryModule(database);
		const source = library.execute({
			type: "create",
			definition: {
				name: "Maren Voss",
				prompt: prompt(),
				openings: ["Source opening."],
			},
		});
		const conversation = createNativeConversation(database, {
			name: "Fork Host",
			humanSeat: {
				type: "adhoc",
				definition: { name: "Writer", prompt: prompt(), openings: [] },
			},
			modelSeat: {
				type: "character",
				characterId: source.id,
				expectedRevision: source.revision,
			},
		});
		const fork = conversation.cast.at(-1);
		if (fork === undefined) throw new Error("Expected a model seat.");

		// A local edit makes the fork differ from its source, so the saved
		// Character must come from the Participant, never from the source.
		const edited = executeConversationCommand(database, {
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			action: {
				type: "rename-participant",
				participantId: fork.id,
				name: "Local Maren",
			},
		});
		const saved = saveParticipantAsCharacter(database, {
			conversationId: conversation.id,
			expectedConversationRevision: edited.revision,
			participantId: fork.id,
		});

		// The new Character is a copy of the edited Participant ...
		expect(saved.character.name).toBe("Local Maren");
		expect(saved.character.openings).toEqual(fork.openings);
		// ... with no reference to the Participant and no change to the
		// source Character or the Conversation.
		const reread = readTestConversationSnapshot(database, conversation.id);
		const unchanged = reread?.cast.find((entry) => entry.id === fork.id);
		expect(unchanged?.name).toBe("Local Maren");
		expect(unchanged?.sourceCharacterId).toBe(source.id);
		expect(library.get(source.id)?.name).toBe("Maren Voss");
		expect(library.get(saved.character.id)?.name).toBe("Local Maren");
		expect(reread?.revision).toBe(edited.revision);
	});

	test("a stale Conversation revision fails with the typed conflict and creates no Character", () => {
		const { conversation } = conversationWithDefinition();
		const participant = conversation.cast.at(-1);
		if (participant === undefined) throw new Error("Expected a model seat.");

		// Another actor advances the Conversation after the client read.
		executeConversationCommand(database, {
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			action: {
				type: "add-participant",
				definition: { name: "Concurrent", prompt: prompt(), openings: [] },
			},
		});

		let conflict: StaleConversationRevisionError | undefined;
		try {
			saveParticipantAsCharacter(database, {
				conversationId: conversation.id,
				expectedConversationRevision: conversation.revision,
				participantId: participant.id,
			});
		} catch (error) {
			if (error instanceof StaleConversationRevisionError) conflict = error;
		}

		expect(conflict).toBeDefined();
		expect(conflict?.expectedRevision).toBe(conversation.revision);
		expect(conflict?.actualRevision).toBe(conversation.revision + 1);
		// Atomic: nothing was created and the Conversation did not move again.
		expect(countRows(characterTable)).toBe(0);
		expect(
			readTestConversationSnapshot(database, conversation.id)?.cast,
		).toHaveLength(3);
	});

	test("a missing Participant fails as not found and creates no Character", () => {
		const { conversation } = conversationWithDefinition();

		expect(() =>
			saveParticipantAsCharacter(database, {
				conversationId: conversation.id,
				expectedConversationRevision: conversation.revision,
				participantId: 987654,
			}),
		).toThrow(ParticipantNotFoundError);
		expect(countRows(characterTable)).toBe(0);
		expect(
			readTestConversationSnapshot(database, conversation.id)?.revision,
		).toBe(conversation.revision);
	});

	test("a missing Conversation fails as not found and creates no Character", () => {
		expect(() =>
			saveParticipantAsCharacter(database, {
				conversationId: 424242,
				expectedConversationRevision: 0,
				participantId: 1,
			}),
		).toThrow(ConversationNotFoundError);
		expect(countRows(characterTable)).toBe(0);
	});

	test("a copied Definition that fails validation creates no partial Character", () => {
		const { conversation } = conversationWithDefinition();

		// A Participant whose stored name is blank cannot exist through the
		// domain seams; the direct insert simulates the impossible state the
		// workflow must still fail safely against.
		const inserted = drizzle(database)
			.insert(participantTable)
			.values({
				conversation_id: conversation.id,
				name: "   ",
				position: 3,
				source_character_id: null,
			})
			.returning({ id: participantTable.id })
			.get();
		if (inserted === undefined) throw new Error("Insert failed.");
		drizzle(database)
			.insert(participantPromptTable)
			.values({
				participant_id: inserted.id,
				system_instruction: "",
				identity: "",
				scenario: "",
				example_dialogue: "",
				post_history_instruction: "",
			})
			.run();

		expect(() =>
			saveParticipantAsCharacter(database, {
				conversationId: conversation.id,
				expectedConversationRevision: conversation.revision,
				participantId: inserted.id,
			}),
		).toThrow(InvalidCharacterDefinitionError);
		// Atomic: the blank-name Character never leaks into the Library.
		expect(countRows(characterTable)).toBe(0);
		expect(
			readTestConversationSnapshot(database, conversation.id)?.cast,
		).toHaveLength(3);
	});

	test("later independent edits to the Character and the Participant never resync", () => {
		const { conversation } = conversationWithDefinition();
		const participant = conversation.cast.at(-1);
		if (participant === undefined) throw new Error("Expected a model seat.");

		const { character } = saveParticipantAsCharacter(database, {
			conversationId: conversation.id,
			expectedConversationRevision: conversation.revision,
			participantId: participant.id,
		});

		const library = createCharacterLibraryModule(database);
		library.execute({
			type: "rename",
			characterId: character.id,
			expectedRevision: character.revision,
			name: "Library Rename",
		});
		const editedConversation = executeConversationCommand(database, {
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			action: {
				type: "replace-participant-openings",
				participantId: participant.id,
				openings: ["A locally rewritten opening."],
			},
		});

		const libraryAfter = library.get(character.id);
		expect(libraryAfter?.name).toBe("Library Rename");
		// The source participant still holds the original openings: the
		// library rename did not touch it.
		expect(
			editedConversation.cast.find((entry) => entry.id === participant.id)
				?.openings,
		).toEqual(["A locally rewritten opening."]);
		expect(libraryAfter?.openings).toEqual(participantDefinition().openings);
	});
});
