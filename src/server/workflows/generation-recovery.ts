import type { Database } from "bun:sqlite";
import {
	cleanupRetainedGenerationInspections,
	readActiveGenerationsForRecovery,
	stopConversationGeneration,
	type GenerationRecoveryCause,
} from "../conversation";
import {
	generationRuntimeFor,
	type GenerationRuntimeRegistry,
} from "./generation-runtime";

export interface GenerationRecoverySummary {
	readonly inspected: number;
	readonly interrupted: number;
	readonly removed: number;
	readonly failed: number;
}

/** @approved
 * Resolve abandoned local execution state once, without contacting a Model
 * Client. This intentionally operates through the same typed terminal seams
 * as a live workflow so revision and sibling-selection invariants remain in
 * one place. A second sweep is harmless: terminal transitions remove rows.
 */
export function recoverActiveGenerations(
	database: Database,
	options: { readonly cause?: GenerationRecoveryCause; readonly conversationIds?: readonly number[] } = {},
): GenerationRecoverySummary {
	const cause = options.cause ?? "server-restart";
	cleanupRetainedGenerationInspections(database);
	const rows = readActiveGenerationsForRecovery(database).filter((row) => options.conversationIds?.includes(row.conversationId) ?? true);
	let interrupted = 0;
	let removed = 0;
	let failed = 0;
	for (const row of rows) {
		try {
			stopConversationGeneration(database, {
				conversationId: row.conversationId,
				generationId: row.id,
				cause,
			});
			if (row.checkpointContent.length > 0 || row.checkpointReasoning.length > 0) interrupted += 1;
			else removed += 1;
		} catch (error) {
			const detail = error instanceof Error ? error.stack ?? error.message : String(error);
			console.error(
				`[generation-recovery] Failed ${cause} recovery for generation ${row.id} ` +
				`in conversation ${row.conversationId}: ${detail}`,
			);
			failed += 1;
		}
	}
	return { inspected: rows.length, interrupted, removed, failed };
}

/** @approved Terminalize local Active Generations before a graceful database close. */
export const shutdownActiveGenerations = (database: Database): GenerationRecoverySummary =>
	recoverActiveGenerations(database, { cause: "server-shutdown" });

/** @approved Stop preparation and providers, terminalize persisted rows, then join detached work before closing the database. */
export async function gracefullyShutdownGenerations(
	database: Database,
	runtime: GenerationRuntimeRegistry = generationRuntimeFor(database),
): Promise<GenerationRecoverySummary> {
	runtime.beginShutdown();
	runtime.flushAll();
	runtime.stopAll();
	const summary = shutdownActiveGenerations(database);
	await runtime.drain();
	return summary;
}
