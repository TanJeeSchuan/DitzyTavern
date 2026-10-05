import { eq } from "drizzle-orm";
import {
	characterOpeningTable,
	characterPromptTable,
	characterTable,
} from "../database/schema";
import type { CharacterDatabase } from "./internal";
import { readDeletionImpact } from "./snapshot";
import type { CharacterDeletionResult } from "./types";

// ==[HUMAN APPROVED]== Confirmed Character deletion inside one transaction.
//
// An unreferenced Character (no Participant provenance reference anywhere)
// is hard-deleted: removing the lifecycle row cascades its Prompt and
// Opening children away with it. A referenced Character becomes a hidden,
// nonrestorable tombstone retaining only stable identity and final name —
// the Prompt and Openings are stripped explicitly while the base row stays
// so Participant provenance keeps pointing at an immutable source identity.
// The deletion mode derives from the same reference count the reads expose,
// so the presented impact can never drift from the executed behavior.
export function deleteCharacter(
	db: CharacterDatabase,
	characterId: number,
): CharacterDeletionResult {
	const impact = readDeletionImpact(db, characterId);
	if (impact.provenanceReferenceCount === 0) {
		db.delete(characterTable)
			.where(eq(characterTable.id, characterId))
			.run();
		return { characterId, deletionMode: "hard-delete" };
	}

	db.update(characterTable)
		.set({ deleted_at: new Date().toISOString() })
		.where(eq(characterTable.id, characterId))
		.run();
	db.delete(characterPromptTable)
		.where(eq(characterPromptTable.character_id, characterId))
		.run();
	db.delete(characterOpeningTable)
		.where(eq(characterOpeningTable.character_id, characterId))
		.run();
	return { characterId, deletionMode: "tombstone" };
}