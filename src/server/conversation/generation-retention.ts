import type { Database } from "bun:sqlite";
import { eq, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { generationReplayTable } from "../database/schema";

export const GENERATION_REPLAY_RETENTION_MS = 5 * 60 * 1_000;

export function removeRetainedGenerationInspection(
	database: Database,
	generationId: number,
): void {
	drizzle(database)
		.delete(generationReplayTable)
		.where(eq(generationReplayTable.id, generationId))
		.run();
}

export function cleanupRetainedGenerationInspections(
	database: Database,
	now = new Date(),
): number {
	return drizzle(database)
		.delete(generationReplayTable)
		.where(lte(generationReplayTable.expires_at, now.toISOString()))
		.returning({ id: generationReplayTable.id })
		.all().length;
}
