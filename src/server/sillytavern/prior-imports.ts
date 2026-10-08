// @approved
//  Prior-import duplicate classification shared by the developer import path
// and the staged preview. A matching raw-byte SHA-256 means an exact
// duplicate of the selected source; a match only on the source-declared
// integrity (which remains advisory, never a verified content digest) is a
// related source. Both kinds are presented as matching prior imports, but
// only exact matches demand the explicit duplicate-copy confirmation later.

import type { Database } from "bun:sqlite";
import { and, eq, inArray, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { conversationDataTable, conversationTable } from "../database/schema";
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
	const readableIds = new Set(
		db
			.select({
				conversationId: conversationDataTable.conversation_id,
				value: conversationDataTable.value,
			})
			.from(conversationDataTable)
			.where(
				and(
					eq(conversationDataTable.namespace, IMPORT_NAMESPACE),
					eq(conversationDataTable.key, IMPORT_KEYS.reportJson),
					inArray(conversationDataTable.conversation_id, candidateIds),
				),
			)
			.all()
			.filter((row) => decodeSillyTavernImportReport(row.value) !== null)
			.map((row) => row.conversationId),
	);

	// @approved
	//  Exact evidence is authoritative and collected first; a Chat matching
	// both keys is reported once as exact regardless of row order. The
	// related set then excludes every already-exact Chat.
	const exactIds: number[] = [];
	const seenExact = new Set<number>();
	const relatedIds: number[] = [];
	const seenRelated = new Set<number>();
	for (const row of rows) {
		if (!readableIds.has(row.conversationId)) continue;
		if (row.key !== IMPORT_KEYS.sha256) continue;
		if (seenExact.has(row.conversationId)) continue;
		seenExact.add(row.conversationId);
		exactIds.push(row.conversationId);
	}
	for (const row of rows) {
		if (!readableIds.has(row.conversationId)) continue;
		if (row.key !== IMPORT_KEYS.integrity) continue;
		if (seenExact.has(row.conversationId) || seenRelated.has(row.conversationId)) continue;
		seenRelated.add(row.conversationId);
		relatedIds.push(row.conversationId);
	}

	const orderedIds = [...exactIds, ...relatedIds];
	if (orderedIds.length === 0) return { exact: [], related: [] };

	const names = new Map<number, string>();
	for (const row of db
		.select({ id: conversationTable.id, name: conversationTable.name })
		.from(conversationTable)
		.where(inArray(conversationTable.id, orderedIds))
		.all()) {
		names.set(row.id, row.name);
	}

	return {
		exact: exactIds.map((id) => ({ id, name: names.get(id) ?? "" })),
		related: relatedIds.map((id) => ({ id, name: names.get(id) ?? "" })),
	};
}
