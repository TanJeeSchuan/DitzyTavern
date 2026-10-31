import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { effectiveRecord, readBoxLifecycles, readExistingSources, readRecordSlots, sha256 } from "@/box-sdk/server";
import { memoryRecord, type MemoryRecord, type MemorySources } from "./contract";
import { readMemoryLabelState } from "./server-chat";
import { applyMemoryPeople } from "./shared";

/** @approved Fork remaps evidence Message IDs; the record's content fingerprint must survive that remapping. */
export const memoryRecordFingerprint = (record: MemoryRecord) => sha256(JSON.stringify({
	claims: record.claims.map((claim) => ({ ...claim, evidence: claim.evidence.map(({ excerpt }) => excerpt) })),
})).slice(0, 16);

export const readMemorySources = (database: Database, conversationId: number, cited: Pick<MemorySources, "messageIds" | "variantIds">): MemorySources => {
	const existing = readExistingSources(database, conversationId, cited);
	const db = drizzle(database);
	const slots = readRecordSlots(db, "memory", memoryRecord, readBoxLifecycles(db, conversationId).memory?.instance, existing.variantIds);
	const labels = readMemoryLabelState(database, conversationId);
	const records = [...slots].flatMap(([variantId, slot]) => {
		const record = effectiveRecord(slot);
		return record === undefined ? [] : [{
			variantId, fingerprint: memoryRecordFingerprint(record),
			claims: record.claims.map(({ claim, attribution, people, evidence }) => ({ claim, attribution, people: applyMemoryPeople(people, labels.cast, labels.identities, labels.merges), evidence })),
		}];
	});
	const evidenceIds = records.flatMap(({ claims }) => claims.flatMap(({ evidence }) => evidence.map(({ messageId }) => messageId)));
	return { ...readExistingSources(database, conversationId, { messageIds: [...cited.messageIds, ...evidenceIds], variantIds: existing.variantIds }), records };
};
