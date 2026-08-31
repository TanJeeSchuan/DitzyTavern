import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	activeGenerationTable,
	chatTable,
} from "../database/schema";
import {
	cleanupRetainedGenerationInspections,
	createConversationModule,
	isSiblingGenerationRow,
	type ConversationDataEntry,
} from "../conversation";
import {
	defaultGenerationRuntime,
	type GenerationRuntimeRegistry,
} from "./generation-runtime";

/** The only local terminal causes used by startup and graceful shutdown. */
export type GenerationRecoveryCause = "server-restart" | "server-shutdown";

export interface GenerationRecoverySummary {
	readonly inspected: number;
	readonly interrupted: number;
	readonly removed: number;
	readonly failed: number;
}

interface ActiveRecoveryRow {
	id: number;
	chatId: number;
	checkpointContent: string;
	checkpointReasoning: string;
	// Kept under the persisted column name so the row satisfies the canonical
	// intent reader without re-parsing the JSON here.
	generation_intent_json: string;
}

const readActiveRows = (database: Database): ActiveRecoveryRow[] => drizzle(database)
	.select({
		id: activeGenerationTable.id,
		chatId: activeGenerationTable.chat_id,
		checkpointContent: activeGenerationTable.checkpoint_content,
		checkpointReasoning: activeGenerationTable.checkpoint_reasoning,
		generation_intent_json: activeGenerationTable.generation_intent_json,
	})
	.from(activeGenerationTable)
	.innerJoin(chatTable, eq(chatTable.id, activeGenerationTable.chat_id))
	.all();

/**
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
	const conversation = createConversationModule(database);
	const rows = readActiveRows(database);
	let interrupted = 0;
	let removed = 0;
	let failed = 0;
	for (const row of rows) {
		const content = row.checkpointContent;
		const reasoning = row.checkpointReasoning;
		const intent = isSiblingGenerationRow(row) ? "sibling" : "tail";
		try {
			if (content.length > 0 || reasoning.length > 0) {
				const data: ConversationDataEntry[] = [
					{ namespace: "generation", key: "outcome", value: "interrupted" },
					{ namespace: "generation", key: "interruption-cause", value: cause },
				];
				if (reasoning.length > 0) {
					data.push({ namespace: "generation", key: "reasoning", value: reasoning });
				}
				if (intent === "sibling") {
					conversation.resolveSiblingGeneration({
						conversationId: row.chatId,
						generationId: row.id,
						timestamp: new Date().toISOString(),
						content,
						data,
					});
				} else {
					conversation.resolveTailGeneration({
						conversationId: row.chatId,
						generationId: row.id,
						timestamp: new Date().toISOString(),
						content,
						data,
					});
				}
				interrupted += 1;
			} else {
				// The canonical removal seam reads the persisted intent itself:
				// Sibling attempts lose their provisional Variant, Tail and
				// Continuation attempts their provisional Message. The accepted
				// human Message of a Tail attempt is never removed here.
				conversation.removeGeneration({
					conversationId: row.chatId,
					generationId: row.id,
				});
				removed += 1;
			}
		} catch {
			// Continue a small sweep even if one malformed/orphaned row cannot be
			// resolved. The next startup can retry that one row with fresh state.
			failed += 1;
		}
	}
	return { inspected: rows.length, interrupted, removed, failed };
}

/** Terminalize local Active Generations before a graceful database close. */
export const shutdownActiveGenerations = (database: Database): GenerationRecoverySummary =>
	recoverActiveGenerations(database, { cause: "server-shutdown" });

/** Flush and stop the process-owned runtime before terminalizing its rows. */
export function gracefullyShutdownGenerations(
	database: Database,
	runtime: GenerationRuntimeRegistry = defaultGenerationRuntime(),
): GenerationRecoverySummary {
	runtime.flushAll();
	runtime.stopAll();
	return shutdownActiveGenerations(database);
}
