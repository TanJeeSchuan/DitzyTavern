import { eq } from "drizzle-orm";
import { characterTable, participantTable } from "../database/schema";
import type { CharacterDatabase } from "./internal";

// Narrow garbage collection for already-tombstoned Characters.
//
// The Conversation domain owns Participant cleanup; when it removes the
// final provenance reference of a Character — an active Participant being
// hard-deleted, or a Participant tombstone being collected — it invokes this
// mechanism in the same transaction. Only Characters that are already
// tombstones are eligible, and only when no Participant row (active or
// tombstoned) still references them. No general business-rule triggers
// exist; this is the single approved cleanup path.
export function collectReleasedCharacterTombstones(
	db: CharacterDatabase,
	characterIds: readonly number[],
): void {
	for (const characterId of characterIds) {
		const character = db
			.select({ id: characterTable.id, deletedAt: characterTable.deleted_at })
			.from(characterTable)
			.where(eq(characterTable.id, characterId))
			.get();
		// Only tombstones are garbage-collected; active Characters survive
		// the loss of every reference, and already-collected rows are gone.
		if (character === undefined || character.deletedAt === null) {
			continue;
		}
		const referenced = db
			.select({ id: participantTable.id })
			.from(participantTable)
			.where(eq(participantTable.source_character_id, characterId))
			.limit(1)
			.get();
		if (referenced !== undefined) {
			continue;
		}
		db.delete(characterTable)
			.where(eq(characterTable.id, characterId))
			.run();
	}
}