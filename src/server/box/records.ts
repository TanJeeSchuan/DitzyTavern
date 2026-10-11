import type { RaceState } from "../../shared/contract/race";
import { foldRaceRecords } from "./race-engine";
import type { Static } from "@sinclair/typebox";
import { boxRecordSlots } from "../../shared/contract/box-generation";
import { Value } from "@sinclair/typebox/value";
import { and, eq, inArray } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { boxReference, type BoxSetups, type DigestBoxId, type WorldClockRecord, type WorldClockRecordSlot } from "../../shared/contract/box";
import { messageVariantDataTable } from "../database/schema";
import { sha256 } from "../memory/hash";
import { SEED_KEY, SEED_NAMESPACE } from "./seed";
import type { BoxInstances } from "./setup";
import { worldClockBox, type WorldClockState } from "./world-clock";

// @approved
//  Record slots live in Variant data under `box:<id>`, key
// `record:<instance>`: each slot belongs to the Box instance that wrote it,
// and only the current instance's slots fold.
export type RecordStates = { readonly "world-clock": WorldClockState; readonly race: RaceState | null };

export const recordKey = (instance: string) => `record:${instance}`;

const decodeSlot = <Id extends keyof typeof boxRecordSlots>(id: Id, stored: string): Static<typeof boxRecordSlots[Id]> => {
	const slot: unknown = JSON.parse(stored);
	if (!Value.Check(boxRecordSlots[id], slot)) throw new Error(`A stored ${id} Box record does not match its schema. Clear the ${boxReference(id)} namespace.`);
	return slot;
};

/** @approved An absent Box has no instance and so no records. */
export const readRecordSlots = <Id extends keyof typeof boxRecordSlots>(db: BunSQLiteDatabase, id: Id, instance: string | undefined, variantIds: readonly number[]): Map<number, Static<typeof boxRecordSlots[Id]>> =>
	instance === undefined || variantIds.length === 0 ? new Map() : new Map(db
		.select({ variantId: messageVariantDataTable.message_variant_id, value: messageVariantDataTable.value })
		.from(messageVariantDataTable)
		.where(and(inArray(messageVariantDataTable.message_variant_id, [...variantIds]), eq(messageVariantDataTable.namespace, boxReference(id)), eq(messageVariantDataTable.key, recordKey(instance))))
		.all()
		.map((row) => [row.variantId, decodeSlot(id, row.value)]));

/** @approved The effective value of one Box record slot: the writer's override, else the automatic result. */
export const effectiveRecord = (slot: WorldClockRecordSlot | undefined): WorldClockRecord | undefined => slot?.writer ?? slot?.automatic;

/** @approved Whether the slot holds the automatic result for exactly this text; an edit makes the stored result stale. */
export const hasAutomaticRecord = (slot: WorldClockRecordSlot | undefined, content: string): boolean => slot?.source === sha256(content);

/** @approved State is the fold over effective records of the selected Variants, in Message order. */
export const foldRecordStates = (db: BunSQLiteDatabase, selectedVariantIds: readonly number[], setups: BoxSetups, instances: BoxInstances): RecordStates => {
	const slots = readRecordSlots(db, "world-clock", instances["world-clock"], selectedVariantIds);
	const raceSlots = readRecordSlots(db, "race", instances.race, selectedVariantIds);
	const { fold, initial } = worldClockBox.records;
	return {
		race: foldRaceRecords(selectedVariantIds.flatMap((id) => raceSlots.get(id)?.automatic ?? []), setups.race.raceId),
		"world-clock": selectedVariantIds.reduce<WorldClockState>((state, variantId) => {
			const record = effectiveRecord(slots.get(variantId));
			return record === undefined ? state : fold(state, record);
		}, initial),
	};
};

const writeSlot = (db: BunSQLiteDatabase, id: DigestBoxId, instance: string, variantId: number, slot: WorldClockRecordSlot): void => {
	const value = JSON.stringify(slot);
	db.insert(messageVariantDataTable)
		.values({ message_variant_id: variantId, namespace: boxReference(id), key: recordKey(instance), value })
		.onConflictDoUpdate({ target: [messageVariantDataTable.message_variant_id, messageVariantDataTable.namespace, messageVariantDataTable.key], set: { value } })
		.run();
};

export const writeAutomaticRecord = (db: BunSQLiteDatabase, id: DigestBoxId, instance: string, variantId: number, record: WorldClockRecord, source: string): void =>
	writeSlot(db, id, instance, variantId, { ...readRecordSlots(db, id, instance, [variantId]).get(variantId), automatic: record, source });

/** @approved A Writer override replaces the effective value without touching the automatic result or the prose. */
export const writeWriterRecord = (db: BunSQLiteDatabase, id: DigestBoxId, instance: string, variantId: number, record: WorldClockRecord): void =>
	writeSlot(db, id, instance, variantId, { ...readRecordSlots(db, id, instance, [variantId]).get(variantId), writer: record });

/** @approved Reset removes the Writer override; with no automatic result left the slot row goes away entirely. */
export const resetWriterRecord = (db: BunSQLiteDatabase, id: DigestBoxId, instance: string, variantId: number): void => {
	const current = readRecordSlots(db, id, instance, [variantId]).get(variantId);
	if (current === undefined || current.writer === undefined) return;
	if (current.automatic === undefined) {
		db.delete(messageVariantDataTable)
			.where(and(eq(messageVariantDataTable.message_variant_id, variantId), eq(messageVariantDataTable.namespace, boxReference(id)), eq(messageVariantDataTable.key, recordKey(instance))))
			.run();
		return;
	}
	writeSlot(db, id, instance, variantId, { automatic: current.automatic, source: current.source });
};

export const readVariantSeeds = (db: BunSQLiteDatabase, variantIds: readonly number[]): Map<number, string> =>
	variantIds.length === 0 ? new Map() : new Map(db
		.select({ variantId: messageVariantDataTable.message_variant_id, value: messageVariantDataTable.value })
		.from(messageVariantDataTable)
		.where(and(inArray(messageVariantDataTable.message_variant_id, [...variantIds]), eq(messageVariantDataTable.namespace, SEED_NAMESPACE), eq(messageVariantDataTable.key, SEED_KEY)))
		.all()
		.map((row) => [row.variantId, row.value]));
