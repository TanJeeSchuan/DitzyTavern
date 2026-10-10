import type { Database } from "bun:sqlite";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { memoryCollectionTable } from "../database/schema";
import { isMemoryEnabled } from "./settings";
import { abortMemoryWork } from "./work";

export function invalidateMemoryWorkForConversation(database: Database, conversationId: number, reason: string) {
	const db = drizzle(database);
	const superseded = db
		.update(memoryCollectionTable)
		.set({
			work_epoch: sql`${memoryCollectionTable.work_epoch} + 1`,
			status: "failed",
			error: reason,
			updated_at: new Date().toISOString(),
		})
		.where(and(
			eq(memoryCollectionTable.conversation_id, conversationId),
			eq(memoryCollectionTable.ownership, "automatic"),
			inArray(memoryCollectionTable.status, ["pending", "running"]),
		))
		.returning({ id: memoryCollectionTable.variant_id })
		.all();
	abortMemoryWork(database, superseded.map(({ id }) => id));
	if (!isMemoryEnabled(database)) {
		const all = db.select({ id: memoryCollectionTable.variant_id }).from(memoryCollectionTable).where(eq(memoryCollectionTable.conversation_id, conversationId)).all();
		abortMemoryWork(database, all.map(({ id }) => id));
	}
}
