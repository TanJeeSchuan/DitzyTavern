import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { queueBoxDigest, startBoxDigests } from "../box/digest";
import { readRecordSlots } from "../box/records";
import { readBoxInstances } from "../box/setup";
import type { ModelFetch } from "../model-client/types";

/** @approved Runs the host digest queue on one passage until its Memory record slot holds a result or an error, and returns the slot. */
export const digestMemoryNow = async (database: Database, conversationId: number, variantId: number, fetch: ModelFetch) => {
	const slot = () => readRecordSlots(drizzle(database), "memory", readBoxInstances(drizzle(database), conversationId).memory, [variantId]).get(variantId);
	const stop = startBoxDigests(database, { fetch });
	try {
		queueBoxDigest(database, conversationId, "memory", variantId);
		for (let attempt = 0; attempt < 2_000 && slot()?.source === undefined && slot()?.error === undefined; attempt += 1) await Bun.sleep(1);
	} finally { await stop(); }
	return slot();
};
