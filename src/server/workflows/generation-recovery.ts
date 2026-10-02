import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	activeGenerationTable,
	conversationTable,
} from "../database/schema";
import {
	cleanupRetainedGenerationInspections,
	createConversationModule,
} from "../conversation";
import {
	generationRuntimeFor,
	type GenerationRuntimeRegistry,
} from "./generation-runtime";
import { interruptedGenerationData } from "./generate-server-owned";

/** ==[HUMAN APPROVED]== The only local terminal causes used by startup and graceful shutdown. */
export type GenerationRecoveryCause = "server-restart" | "server-shutdown";

export interface GenerationRecoverySummary {
	readonly inspected: number;
	readonly interrupted: number;
	readonly removed: number;
	readonly failed: number;
}

interface ActiveRecoveryRow {
	id: number;
	conversationId: number;
	checkpointContent: string;
	checkpointReasoning: string;
	// ==[HUMAN APPROVED]== Kept under the persisted column name so the row satisfies the canonical
	// intent reader without re-parsing the JSON here.
	generation_intent_json: string;
}

const readActiveRows = (database: Database): ActiveRecoveryRow[] => drizzle(database)
	.select({
		id: activeGenerationTable.id,
		conversationId: activeGenerationTable.conversation_id,
		checkpointContent: activeGenerationTable.checkpoint_content,
		checkpointReasoning: activeGenerationTable.checkpoint_reasoning,
		generation_intent_json: activeGenerationTable.generation_intent_json,
	})
	.from(activeGenerationTable)
	.innerJoin(conversationTable, eq(conversationTable.id, activeGenerationTable.conversation_id))
	.all();

/**
 * ==[HUMAN APPROVED]== Resolve abandoned local execution state once, without contacting a Model
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
	const conversation = createConversationModule(database);
	const rows = readActiveRows(database);
	let interrupted = 0;
	let removed = 0;
	let failed = 0;
	for (const row of rows) {
		const content = row.checkpointContent;
		const reasoning = row.checkpointReasoning;
		try {
			if (content.length > 0 || reasoning.length > 0) {
				const data = interruptedGenerationData(cause, reasoning);
				conversation.resolveGeneration({
					conversationId: row.conversationId,
					generationId: row.id,
					timestamp: new Date().toISOString(),
					content,
					data,
				});
				interrupted += 1;
			} else {
				// ==[HUMAN APPROVED]== The canonical removal seam reads the persisted intent itself:
				// Sibling attempts lose their provisional Variant, Tail and
				// Continuation attempts their provisional Message. The accepted
				// human Message of a Tail attempt is never removed here.
				conversation.removeGeneration({
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

/** ==[HUMAN APPROVED]== Terminalize local Active Generations before a graceful database close. */
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
