import { eq } from "drizzle-orm";
import {
	characterDataTable,
	characterLorebookAttachmentTable,
	characterOpeningTable,
	characterPromptTable,
	characterTable,
} from "../database/schema";
import type { CharacterDatabase } from "./internal";
import { readDeletionImpact } from "./snapshot";
import type { CharacterDeletionResult } from "./types";

export function tombstone(
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
		.set({ deleted_at: new Date().toISOString(), pinned: false })
		.where(eq(characterTable.id, characterId))
		.run();
	db.delete(characterPromptTable)
		.where(eq(characterPromptTable.character_id, characterId))
		.run();
	db.delete(characterOpeningTable)
		.where(eq(characterOpeningTable.character_id, characterId))
		.run();
	db.delete(characterDataTable).where(eq(characterDataTable.character_id, characterId)).run();
	db.delete(characterLorebookAttachmentTable).where(eq(characterLorebookAttachmentTable.character_id, characterId)).run();
	return { characterId, deletionMode: "tombstone" };
}
