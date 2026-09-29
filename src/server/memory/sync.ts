import type { Database } from "bun:sqlite";
import { invalidateMemoryWorkForConversation } from "./cancellation";
import { invalidateMemoryWorkForVariant, queueMemorySource, queueMemoryTail } from "./collections";
import { sha256 } from "./hash";
import { abortMemoryWork, registeredMemoryVariants } from "./work";

interface SourceRow { id: number; message_id: number; selected: number; content: string; source_hash: string | null }

export function syncMemorySources(database: Database, conversationId: number, variantIds: readonly number[]): void {
	const registered = registeredMemoryVariants(database);
	const rows = new Map(database.query<SourceRow, [string]>("SELECT v.id, v.message_id, v.selected, v.content, c.source_hash FROM message_variant v LEFT JOIN memory_collection c ON c.variant_id = v.id WHERE v.id IN (SELECT value FROM json_each(?))").all(JSON.stringify([...registered, ...variantIds])).map((row) => [row.id, row]));
	abortMemoryWork(database, registered.filter((id) => !rows.has(id)));
	for (const id of variantIds) {
		const row = rows.get(id);
		if (!row) continue;
		if (row.source_hash !== null && row.source_hash !== sha256(row.content)) invalidateMemoryWorkForVariant(database, id);
		if (row.selected) queueMemorySource(database, conversationId, row.message_id);
	}
}

export function refreshMemoryForConversation(database: Database, conversationId: number, reason?: string): void {
	invalidateMemoryWorkForConversation(database, conversationId, reason);
	queueMemoryTail(database, conversationId);
}
