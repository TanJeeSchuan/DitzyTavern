import { readActiveGenerationsForRecovery } from "../conversation";
import { resolveConversationGeneration, removeConversationGeneration } from "../conversation";
import type { Database } from "bun:sqlite";

import { cleanupRetainedGenerationInspections } from "../conversation";
import {
	generationRuntimeFor,
	type GenerationRuntimeRegistry,
} from "./generation-runtime";
import { interruptedGenerationData } from "./generate-server-owned";

/** @approved The only local terminal causes used by startup and graceful shutdown. */
export type GenerationRecoveryCause = "server-restart" | "server-shutdown";

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
	options: { readonly cause?: GenerationRecoveryCause } = {},
): GenerationRecoverySummary {
	const cause = options.cause ?? "server-restart";
	cleanupRetainedGenerationInspections(database);
	const conversation = database;
	const rows = readActiveGenerationsForRecovery(database);
	let interrupted = 0;
	let removed = 0;
	let failed = 0;
	for (const row of rows) {
		const content = row.checkpointContent;
		const reasoning = row.checkpointReasoning;
		try {
			if (content.length > 0 || reasoning.length > 0) {
				const data = interruptedGenerationData(cause, reasoning);
				resolveConversationGeneration(conversation, {
					conversationId: row.conversationId,
					generationId: row.id,
					timestamp: new Date().toISOString(),
					content,
					data,
				});
				interrupted += 1;
			} else {
				// @approved
				//  The canonical removal seam reads the persisted intent itself:
				// Sibling attempts lose their provisional Variant, Tail and
				// Continuation attempts their provisional Message. The accepted
				// human Message of a Tail attempt is never removed here.
				removeConversationGeneration(conversation, {
					conversationId: row.conversationId,
					generationId: row.id,
				});
				removed += 1;
			}
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

/** Stop preparation and providers, terminalize persisted rows, then join detached work before closing the database. */
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
