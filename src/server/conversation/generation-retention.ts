import type { Database } from "bun:sqlite";
import { eq, inArray, lte, type SQL } from "drizzle-orm";
import { generationCaptureTable, generationReplayTable } from "../database/schema";
import { runConversationTransaction } from "./commands/transaction";

export const GENERATION_REPLAY_RETENTION_MS = 5 * 60 * 1_000;

/** @approved Every replay deletion removes the retained capture with it; no other row outlives the Variant cascade. */
const deleteRetainedInspections = (database: Database, where: SQL): number =>
	runConversationTransaction(database, (db) => {
		const ids = db.delete(generationReplayTable).where(where).returning({ id: generationReplayTable.id }).all().map(({ id }) => id);
		if (ids.length > 0) db.delete(generationCaptureTable).where(inArray(generationCaptureTable.generation_id, ids)).run();
		return ids.length;
	});

export function removeRetainedGenerationInspection(
	database: Database,
	generationId: number,
): void {
	deleteRetainedInspections(database, eq(generationReplayTable.id, generationId));
}

export function cleanupRetainedGenerationInspections(
	database: Database,
	now = new Date(),
): number {
	return deleteRetainedInspections(database, lte(generationReplayTable.expires_at, now.toISOString()));
}
