import { asc, eq } from "drizzle-orm";
import {
	characterOpeningTable,
	characterPromptTable,
	characterTable,
} from "../database/schema";
import type { CharacterDatabase } from "./internal";
import type {
	CharacterPrompt,
	CharacterSnapshot,
	CharacterSummary,
} from "./types";

const emptyPrompt: CharacterPrompt = {
	systemInstruction: "",
	identity: "",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
};

// Alphabetical order for the library. Case and Unicode differences are
// resolved by the collator; stable identity is only an invisible
// duplicate tie-breaker.
const collator = new Intl.Collator("en", { usage: "sort", numeric: true });

const compareByLibraryOrder = (a: CharacterSummary, b: CharacterSummary) => {
	if (a.pinned !== b.pinned) {
		return a.pinned ? -1 : 1;
	}
	const byName = collator.compare(a.name, b.name);
	if (byName !== 0) {
		return byName;
	}
	return a.id - b.id;
};

export function readCharacterSnapshot(
	db: CharacterDatabase,
	characterId: number,
): CharacterSnapshot | undefined {
	const character = db
		.select()
		.from(characterTable)
		.where(eq(characterTable.id, characterId))
		.get();
	if (character === undefined || character.deleted_at !== null) {
		return undefined;
	}

	const prompt = db
		.select({
			systemInstruction: characterPromptTable.system_instruction,
			identity: characterPromptTable.identity,
			scenario: characterPromptTable.scenario,
			exampleDialogue: characterPromptTable.example_dialogue,
			postHistoryInstruction: characterPromptTable.post_history_instruction,
		})
		.from(characterPromptTable)
		.where(eq(characterPromptTable.character_id, characterId))
		.get();
	const openings = db
		.select({ content: characterOpeningTable.content })
		.from(characterOpeningTable)
		.where(eq(characterOpeningTable.character_id, characterId))
		.orderBy(asc(characterOpeningTable.position))
		.all()
		.map((row) => row.content);

	return {
		id: character.id,
		name: character.name,
		revision: character.revision,
		pinned: character.pinned,
		prompt: prompt ?? emptyPrompt,
		openings,
	};
}

export function listCharacters(db: CharacterDatabase): CharacterSummary[] {
	const characters = db
		.select({
			id: characterTable.id,
			name: characterTable.name,
			revision: characterTable.revision,
			pinned: characterTable.pinned,
			deletedAt: characterTable.deleted_at,
		})
		.from(characterTable)
		.orderBy(asc(characterTable.id))
		.all();

	return characters
		.filter((row) => row.deletedAt === null)
		.map(({ deletedAt: _deletedAt, ...row }) => row)
		.sort(compareByLibraryOrder);
}
