import type { Database } from "bun:sqlite";
import { invalidateMemoryWorkForConversation } from "./cancellation";
import { invalidateMemoryWorkForVariant, queueMemorySource, queueMemoryTail } from "./collections";
import { sha256 } from "./hash";
import { abortMemoryWork, registeredMemoryVariants } from "./work";

interface SourceRow { id: number; message_id: number; selected: number; content: string; source_hash: string | null }

export function abandonMemoryWorkForRemovedVariants(database: Database): void {
	const registered = registeredMemoryVariants(database);
	const existing = new Set(database.query<{ id: number }, [string]>("SELECT id FROM message_variant WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(registered)).map(({ id }) => id));
	abortMemoryWork(database, registered.filter((id) => !existing.has(id)));
}

export function syncMemorySources(database: Database, conversationId: number, variantIds: readonly number[]): void {
	abandonMemoryWorkForRemovedVariants(database);
	const rows = new Map(database.query<SourceRow, [string]>("SELECT v.id, v.message_id, v.selected, v.content, c.source_hash FROM message_variant v LEFT JOIN memory_collection c ON c.variant_id = v.id WHERE v.id IN (SELECT value FROM json_each(?))").all(JSON.stringify(variantIds)).map((row) => [row.id, row]));
	for (const id of variantIds) {
		const row = rows.get(id);
		if (!row) continue;
		if (row.source_hash !== null && row.source_hash !== sha256(row.content)) invalidateMemoryWorkForVariant(database, id);
		if (row.selected) queueMemorySource(database, conversationId, row.message_id);
	}
}

export const syncSelectedMemorySource = (database: Database, conversationId: number, messageId: number): void =>
	syncMemorySources(database, conversationId, database.query<{ id: number }, [number]>("SELECT id FROM message_variant WHERE message_id = ? AND selected = 1").all(messageId).map(({ id }) => id));

export function refreshMemoryForConversation(database: Database, conversationId: number, reason?: string): void {
	invalidateMemoryWorkForConversation(database, conversationId, reason);
	queueMemoryTail(database, conversationId);
}
