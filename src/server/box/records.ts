import { boxRecordSlots, type BoxRecord, type BoxRecordSlot } from "../../shared/contract/box-generation";
import { Value } from "@sinclair/typebox/value";
import { and, eq, inArray } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { boxReference, recordBoxIds, type BoxId, type BoxSetups, type RecordBoxId } from "../../shared/contract/box";
import { messageVariantDataTable } from "../database/schema";
import { sha256 } from "../memory/hash";
import { SEED_KEY, SEED_NAMESPACE } from "./seed";
import type { BoxInstances } from "./setup";
import type { Box, HostBox } from "./contract";
import { serverBox } from "./registry";

// @approved
//  Record slots live in Variant data under `box:<id>`, key
// `record:<instance>`: each slot belongs to the Box instance that wrote it,
// and only the current instance's slots fold.
export const recordKey = (instance: string) => `record:${instance}`;

const decodeSlot = <Id extends RecordBoxId>(id: Id, stored: string): BoxRecordSlot<Id> => {
	const slot: unknown = JSON.parse(stored);
	if (!Value.Check(boxRecordSlots[id], slot)) throw new Error(`A stored ${id} Box record does not match its schema. Clear the ${boxReference(id)} namespace.`);
	return slot;
};

/** @approved An absent Box has no instance and so no records. */
export const readRecordSlots = <Id extends RecordBoxId>(db: BunSQLiteDatabase, id: Id, instance: string | undefined, variantIds: readonly number[]): Map<number, BoxRecordSlot<Id>> =>
	instance === undefined || variantIds.length === 0 ? new Map() : new Map(db
		.select({ variantId: messageVariantDataTable.message_variant_id, value: messageVariantDataTable.value })
		.from(messageVariantDataTable)
		.where(and(inArray(messageVariantDataTable.message_variant_id, [...variantIds]), eq(messageVariantDataTable.namespace, boxReference(id)), eq(messageVariantDataTable.key, recordKey(instance))))
		.all()
		.map((row) => [row.variantId, decodeSlot(id, row.value)]));

type Slot<Rec> = { readonly automatic?: Rec; readonly writer?: Rec; readonly source?: string };

/** @approved The effective value of one Box record slot: the writer's override, else the automatic result. */
export const effectiveRecord = <Rec>(slot: Slot<Rec> | undefined): Rec | undefined => slot?.writer ?? slot?.automatic;

/** @approved Whether the slot holds the automatic result for exactly this text; an edit makes the stored result stale. */
export const hasAutomaticRecord = <Rec>(slot: Slot<Rec> | undefined, content: string): boolean => slot?.source === sha256(content);

/** @approved State is the fold over effective records of the selected Variants, in Message order. */
export const foldRecords = <Setup, Rec, State>(records: NonNullable<Box<Setup, unknown, never, never, Rec, State>["records"]>, setup: Setup, slots: ReadonlyMap<number, Slot<Rec>>, selectedVariantIds: readonly number[]): State =>
	selectedVariantIds.reduce((state, variantId) => {
		const record = effectiveRecord(slots.get(variantId));
		return record === undefined ? state : records.fold(state, record, setup);
	}, records.initial);

/** @approved Every record Box's folded state, as one Generation captures it; only the Box that folded a state reads it. */
export type RecordStates = { readonly [Id in RecordBoxId]?: NonNullable<HostBox["records"]>["initial"] };

export const foldRecordStates = (db: BunSQLiteDatabase, selectedVariantIds: readonly number[], setups: BoxSetups, instances: BoxInstances): RecordStates => {
	const setupOf: Partial<Record<BoxId, BoxSetups[keyof BoxSetups]>> = setups;
	return Object.fromEntries(recordBoxIds.map((id) => [id, foldRecords(serverBox(id).records, setupOf[id], readRecordSlots(db, id, instances[id], selectedVariantIds), selectedVariantIds)]));
};

const writeSlot = (db: BunSQLiteDatabase, id: RecordBoxId, instance: string, variantId: number, slot: Slot<BoxRecord<RecordBoxId>>): void => {
	const value = JSON.stringify(slot);
	db.insert(messageVariantDataTable)
		.values({ message_variant_id: variantId, namespace: boxReference(id), key: recordKey(instance), value })
		.onConflictDoUpdate({ target: [messageVariantDataTable.message_variant_id, messageVariantDataTable.namespace, messageVariantDataTable.key], set: { value } })
		.run();
};

export const writeAutomaticRecord = <Id extends RecordBoxId>(db: BunSQLiteDatabase, id: Id, instance: string, variantId: number, record: BoxRecord<Id>, source: string): void =>
	writeSlot(db, id, instance, variantId, { ...readRecordSlots(db, id, instance, [variantId]).get(variantId), automatic: record, source });

/** @approved A Writer override replaces the effective value without touching the automatic result or the prose. */
export const writeWriterRecord = <Id extends RecordBoxId>(db: BunSQLiteDatabase, id: Id, instance: string, variantId: number, record: BoxRecord<Id>): void =>
	writeSlot(db, id, instance, variantId, { ...readRecordSlots(db, id, instance, [variantId]).get(variantId), writer: record });

/** @approved Reset removes the Writer override; with no automatic result left the slot row goes away entirely. */
export const resetWriterRecord = (db: BunSQLiteDatabase, id: RecordBoxId, instance: string, variantId: number): void => {
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
