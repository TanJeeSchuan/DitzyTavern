import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { TObject } from "@sinclair/typebox";
import type { BoxId } from "../../shared/contract/box";
import { queueBoxDigest, startBoxDigests } from "../box/digest";
import { readRecordSlots, type RecordSlot } from "../box/records";
import { readBoxLifecycles } from "../box/setup";
import type { ModelFetch } from "../model-client/types";

/** @approved Runs the host digest queue on one passage until the Box's record slot holds a result or an error, and returns the slot. */
export const digestNow = async <Rec extends TObject>(database: Database, conversationId: number, box: BoxId, record: Rec, variantId: number, fetch: ModelFetch) => {
	const slot = () => readRecordSlots(drizzle(database), box, record, readBoxLifecycles(drizzle(database), conversationId)[box]?.instance, [variantId]).get(variantId);
	const settled = (current: RecordSlot | undefined) => current?.source !== undefined || current?.error !== undefined;
	const stop = startBoxDigests(database, { fetch });
	try {
		queueBoxDigest(database, conversationId, box, variantId);
		for (let attempt = 0; attempt < 2_000 && !settled(slot()); attempt += 1) await Bun.sleep(1);
	} finally { await stop(); }
	return slot();
};
