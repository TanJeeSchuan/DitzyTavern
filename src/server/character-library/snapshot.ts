import { asc, eq } from "drizzle-orm";
import { firstPromptText, promptPreview } from "../../shared/definition";
import {
	characterOpeningTable,
	characterPromptTable,
	characterTable,
	participantTable,
} from "../database/schema";
import type { CharacterDatabase } from "./internal";
import type {
	CharacterDeletionImpact,
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

// Derives the deletion impact of one Character from its Participant
// provenance references (active and tombstoned rows across every
// Conversation). This is the single reference-count rule shared by reads,
// the confirmation presentation, and the delete command, so the presented
// impact can never drift from the persisted behavior.
export function readDeletionImpact(
	db: CharacterDatabase,
	characterId: number,
): CharacterDeletionImpact {
	const provenanceReferenceCount = db
		.select({ id: participantTable.id })
		.from(participantTable)
		.where(eq(participantTable.source_character_id, characterId))
		.all().length;
	return {
		provenanceReferenceCount,
		deletionMode: provenanceReferenceCount === 0 ? "hard-delete" : "tombstone",
	};
}

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
		deletionImpact: readDeletionImpact(db, characterId),
	};
}

export function listCharacters(db: CharacterDatabase): CharacterSummary[] {
	// One global projection of provenance references drives every summary's
	// used count, so the list never issues a per-Character reference query.
	const references = new Map<number, number>();
	for (const row of db
		.select({ sourceCharacterId: participantTable.source_character_id })
		.from(participantTable)
		.all()) {
		if (row.sourceCharacterId === null) continue;
		references.set(
			row.sourceCharacterId,
			(references.get(row.sourceCharacterId) ?? 0) + 1,
		);
	}

	const rows = db
		.select({
			id: characterTable.id,
			name: characterTable.name,
			revision: characterTable.revision,
			pinned: characterTable.pinned,
			deletedAt: characterTable.deleted_at,
			systemInstruction: characterPromptTable.system_instruction,
			identity: characterPromptTable.identity,
			scenario: characterPromptTable.scenario,
			exampleDialogue: characterPromptTable.example_dialogue,
			postHistoryInstruction: characterPromptTable.post_history_instruction,
		})
		.from(characterTable)
		.leftJoin(
			characterPromptTable,
			eq(characterPromptTable.character_id, characterTable.id),
		)
		.orderBy(asc(characterTable.id))
		.all();

	return rows
		.filter((row) => row.deletedAt === null)
		.map((row) => ({
			id: row.id,
			name: row.name,
			revision: row.revision,
			pinned: row.pinned,
			preview: promptPreview(
				firstPromptText({
					systemInstruction: row.systemInstruction ?? "",
					identity: row.identity ?? "",
					scenario: row.scenario ?? "",
					exampleDialogue: row.exampleDialogue ?? "",
					postHistoryInstruction: row.postHistoryInstruction ?? "",
				}),
			),
			provenanceReferenceCount: references.get(row.id) ?? 0,
		}))
		.sort(compareByLibraryOrder);
}
