import type { Database } from "bun:sqlite";
import { Kind, KindGuard, type TSchema } from "@sinclair/typebox";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { BoxId } from "../../shared/contract/box";
import { checkBoxValuesInChats } from "../conversation";
import { boxSchemaTable } from "../database/schema";
import { sha256 } from "../hash";
import type { CheckedBox } from "./contract";

// @approved
//  Every schema a stored value of the Box is checked against. A Box whose
// schemas fingerprint as they did when its values last all passed has
// nothing to check. A schema's kind is a symbol key JSON drops, so it is
// written in, or two custom kinds would fingerprint alike.
const withKinds = (_key: string, node: TSchema) => KindGuard.IsSchema(node) ? { "~kind": node[Kind], ...node } : node;
const schemaFingerprint = ({ descriptor, box }: CheckedBox) => sha256(JSON.stringify({
	setup: descriptor.setup?.schema, values: descriptor.values, record: descriptor.record,
	moves: descriptor.moves && { schema: descriptor.moves.schema, max: descriptor.moves.max }, trace: box.advance?.trace,
}, withKinds));
const recordFingerprint = (db: BunSQLiteDatabase, checked: CheckedBox) => {
	const fingerprint = schemaFingerprint(checked);
	db.insert(boxSchemaTable).values({ box_id: checked.id, fingerprint }).onConflictDoUpdate({ target: boxSchemaTable.box_id, set: { fingerprint } }).run();
};

// @approved
//  At load, before the server serves, each Box whose schemas changed has its
// stored values checked in every Chat. Its fingerprint is recorded only once
// nothing is held, so a Box with held values is checked again next load.
// A Box whose schemas throw, such as one naming a missing `$id`, is logged
// and left unchecked, so it cannot stop the server. Returns each Box's held
// places.
export const checkStoredBoxValues = (database: Database, boxes: readonly CheckedBox[]): ReadonlyMap<BoxId, readonly string[]> => {
	const db = drizzle(database);
	const recorded = new Map(db.select().from(boxSchemaTable).all().map((row) => [row.box_id, row.fingerprint]));
	const held = new Map<BoxId, readonly string[]>();
	for (const checked of boxes.filter((checked) => recorded.get(checked.id) !== schemaFingerprint(checked))) {
		try {
			const places = checkBoxValuesInChats(database, checked, false);
			if (places.length === 0) recordFingerprint(db, checked);
			else held.set(checked.id, places);
		} catch (error) {
			console.error(`[boxes] Could not check the ${checked.id} Box's stored values: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return held;
};

/** @approved Deletes every value of the Box that still fails its schemas and does not upgrade, then records its fingerprint. */
export const clearHeldBoxValues = (database: Database, checked: CheckedBox): void => {
	checkBoxValuesInChats(database, checked, true);
	recordFingerprint(drizzle(database), checked);
};
