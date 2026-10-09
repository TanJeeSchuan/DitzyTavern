// @approved
//  Prior-import duplicate classification shared by the developer import path
// and the staged preview. A matching raw-byte SHA-256 means an exact
// duplicate of the selected source; a match only on the source-declared
// integrity (which remains advisory, never a verified content digest) is a
// related source. Both kinds are presented as matching prior imports, but
// only exact matches demand the explicit duplicate-copy confirmation later.

import type { Database } from "bun:sqlite";
import { and, eq, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { readConversationDataBatch } from "../conversation";
import { conversationDataTable } from "../database/schema";
import type { ChatImportDuplicateEvidence } from "../../shared/contract/chat-import";
import {
	decodeSillyTavernImportReport,
	IMPORT_KEYS,
	IMPORT_NAMESPACE,
	type SillyTavernImportSource,
} from "./adapter";

// @approved
//  One entry per matching prior Chat, classified into the kind of evidence
// that matched. A prior Chat sharing both the SHA-256 and the declared
// integrity is reported once as exact; the exact evidence wins because it
// is authoritative over the advisory declared value.
export function findPriorImportsBySource(
	database: Database,
	source: SillyTavernImportSource,
): ChatImportDuplicateEvidence {
	const conditions = [
		and(
			eq(conversationDataTable.namespace, IMPORT_NAMESPACE),
			eq(conversationDataTable.key, IMPORT_KEYS.sha256),
			eq(conversationDataTable.value, source.sha256),
		),
	];
	if (source.integrity !== undefined) {
		conditions.push(
			and(
				eq(conversationDataTable.namespace, IMPORT_NAMESPACE),
				eq(conversationDataTable.key, IMPORT_KEYS.integrity),
				eq(conversationDataTable.value, source.integrity),
			),
		);
	}

	const db = drizzle(database);
	const rows = db
		.select({
			conversationId: conversationDataTable.conversation_id,
			key: conversationDataTable.key,
		})
		.from(conversationDataTable)
		.where(or(...conditions))
		.all();
	if (rows.length === 0) return { exact: [], related: [] };

	const candidateIds = [...new Set(rows.map((row) => row.conversationId))];
	// @approved
	//  Each candidate's name and readable report come through the
	//  Conversation-scoped data seam in one bounded batch. Only the
	//  cross-Conversation search for matching digests stays a direct read: the
	//  seam cannot search by entry value.
	const readable = new Map<number, string>();
	const reads = readConversationDataBatch(database, candidateIds, { namespace: IMPORT_NAMESPACE, keys: [IMPORT_KEYS.reportJson] });
	for (const conversationId of candidateIds) {
		const data = reads.get(conversationId);
		if (data && data.entries.some((entry) => decodeSillyTavernImportReport(entry.value) !== null)) readable.set(conversationId, data.name);
	}

	// @approved
	//  Exact evidence is authoritative and collected first; a Chat matching
	// both keys is reported once as exact regardless of row order. The
	// related set then excludes every already-exact Chat.
	const exactIds: number[] = [];
	const seenExact = new Set<number>();
	const relatedIds: number[] = [];
	const seenRelated = new Set<number>();
	for (const row of rows) {
		if (!readable.has(row.conversationId)) continue;
		if (row.key !== IMPORT_KEYS.sha256) continue;
		if (seenExact.has(row.conversationId)) continue;
		seenExact.add(row.conversationId);
		exactIds.push(row.conversationId);
	}
	for (const row of rows) {
		if (!readable.has(row.conversationId)) continue;
		if (row.key !== IMPORT_KEYS.integrity) continue;
		if (seenExact.has(row.conversationId) || seenRelated.has(row.conversationId)) continue;
		seenRelated.add(row.conversationId);
		relatedIds.push(row.conversationId);
	}

	return {
		exact: exactIds.map((id) => ({ id, name: readable.get(id) ?? "" })),
		related: relatedIds.map((id) => ({ id, name: readable.get(id) ?? "" })),
	};
}
