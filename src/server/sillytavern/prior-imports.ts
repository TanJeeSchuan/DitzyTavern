// Prior-import duplicate classification shared by the developer import path
// and the staged preview. A matching raw-byte SHA-256 means an exact
// duplicate of the selected source; a match only on the source-declared
// integrity (which remains advisory, never a verified content digest) is a
// related source. Both kinds are presented as matching prior imports, but
// only exact matches demand the explicit duplicate-copy confirmation later.

import type { Database } from "bun:sqlite";
import { and, eq, inArray, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { chatDataTable, chatTable } from "../database/schema";
import type { ChatImportDuplicateEvidence } from "../../shared/contract/chat-import";
import { IMPORT_KEYS, IMPORT_NAMESPACE, type SillyTavernImportSource } from "./adapter";

// One entry per matching prior Chat, classified into the kind of evidence
// that matched. A prior Chat sharing both the SHA-256 and the declared
// integrity is reported once as exact; the exact evidence wins because it
// is authoritative over the advisory declared value.
export function findPriorImportsBySource(
	database: Database,
	source: SillyTavernImportSource,
): ChatImportDuplicateEvidence {
	const conditions = [
		and(
			eq(chatDataTable.namespace, IMPORT_NAMESPACE),
			eq(chatDataTable.key, IMPORT_KEYS.sha256),
			eq(chatDataTable.value, source.sha256),
		),
	];
	if (source.integrity !== undefined) {
		conditions.push(
			and(
				eq(chatDataTable.namespace, IMPORT_NAMESPACE),
				eq(chatDataTable.key, IMPORT_KEYS.integrity),
				eq(chatDataTable.value, source.integrity),
			),
		);
	}

	const db = drizzle(database);
	const rows = db
		.select({
			chatId: chatDataTable.chat_id,
			key: chatDataTable.key,
		})
		.from(chatDataTable)
		.where(or(...conditions))
		.all();

	// Exact evidence is authoritative and collected first; a Chat matching
	// both keys is reported once as exact regardless of row order. The
	// related set then excludes every already-exact Chat.
	const exactIds: number[] = [];
	const seenExact = new Set<number>();
	const relatedIds: number[] = [];
	const seenRelated = new Set<number>();
	for (const row of rows) {
		if (row.key !== IMPORT_KEYS.sha256) continue;
		if (seenExact.has(row.chatId)) continue;
		seenExact.add(row.chatId);
		exactIds.push(row.chatId);
	}
	for (const row of rows) {
		if (row.key !== IMPORT_KEYS.integrity) continue;
		if (seenExact.has(row.chatId) || seenRelated.has(row.chatId)) continue;
		seenRelated.add(row.chatId);
		relatedIds.push(row.chatId);
	}

	const orderedIds = [...exactIds, ...relatedIds];
	if (orderedIds.length === 0) return { exact: [], related: [] };

	const names = new Map<number, string>();
	for (const row of db
		.select({ id: chatTable.id, name: chatTable.name })
		.from(chatTable)
		.where(inArray(chatTable.id, orderedIds))
		.all()) {
		names.set(row.id, row.name);
	}

	return {
		exact: exactIds.map((id) => ({ id, name: names.get(id) ?? "" })),
		related: relatedIds.map((id) => ({ id, name: names.get(id) ?? "" })),
	};
}
