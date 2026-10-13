import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { and, eq, inArray } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { boxRecordSchema, boxReference, type BoxId, type BoxSetups, type BoxStates } from "../../shared/contract/box";
import type { BoxValue } from "../../shared/contract/box-value";
import { boxRecordSlot } from "../../shared/contract/box-digest";
import { messageVariantDataTable } from "../database/schema";
import { sha256 } from "../hash";
import { SEED_KEY, SEED_NAMESPACE } from "./seed";
import type { BoxInstances } from "./setup";
import type { Box, HostBox } from "./contract";
import { serverBoxes } from "./registry";

// @approved
//  Record slots live in Variant data under `box:<id>`, key
// `record:<instance>`: each slot belongs to the Box instance that wrote it,
// and only the current instance's slots fold.
export const recordKey = (instance: string) => `record:${instance}`;

/** @approved One Box record slot, its records typed by the schema it was read with. */
export type RecordSlot<Rec = unknown> = { readonly automatic?: Rec; readonly writer?: Rec; readonly source?: string; readonly error?: { readonly source: string; readonly message: string } };

// @approved
//  Each stored slot is checked against `record`, the Box's record schema. An
//  absent Box has no instance and so no records.
export const readRecordSlots = <Rec extends TSchema>(db: BunSQLiteDatabase, id: BoxId, record: Rec, instance: string | undefined, variantIds: readonly number[]): Map<number, RecordSlot<Static<Rec>>> => {
	if (instance === undefined || variantIds.length === 0) return new Map();
	const schema = boxRecordSlot(record);
	return new Map(db
		.select({ variantId: messageVariantDataTable.message_variant_id, value: messageVariantDataTable.value })
		.from(messageVariantDataTable)
		.where(and(inArray(messageVariantDataTable.message_variant_id, [...variantIds]), eq(messageVariantDataTable.namespace, boxReference(id)), eq(messageVariantDataTable.key, recordKey(instance))))
		.all()
		.map((row) => {
			const slot: unknown = JSON.parse(row.value);
			if (!Value.Check(schema, slot)) throw new Error(`A stored ${id} Box record does not match its schema. Clear the ${boxReference(id)} namespace.`);
			return [row.variantId, slot];
		}));
};
const slotOf = (db: BunSQLiteDatabase, id: BoxId, instance: string, variantId: number): RecordSlot<BoxValue> | undefined =>
	readRecordSlots(db, id, boxRecordSchema(id), instance, [variantId]).get(variantId);

/** @approved The effective value of one Box record slot: the writer's override, else the automatic result. */
export const effectiveRecord = <S extends RecordSlot>(slot: S | undefined): S["writer"] | S["automatic"] | undefined => slot?.writer ?? slot?.automatic;

/** @approved Whether the slot holds the automatic result for exactly this text; an edit makes the stored result stale. */
export const hasAutomaticRecord = (slot: RecordSlot | undefined, content: string): boolean => slot?.source === sha256(content);

/** @approved State is the fold over effective records of the selected Variants, in Message order. */
export const foldRecords = <Setup, Rec, State>(records: NonNullable<Box<Setup, unknown, never, Rec, State>["records"]>, setup: Setup, slots: ReadonlyMap<number, RecordSlot<Rec>>, selectedVariantIds: readonly number[]): State =>
	selectedVariantIds.reduce((state, variantId) => {
		const record = effectiveRecord(slots.get(variantId));
		return record === undefined ? state : records.fold(state, record, setup);
	}, records.initial);

/** @approved Every enabled record Box's folded state, by Box id, as one Generation captures it; only the Box that folded a state reads it. */
export type RecordStates = Readonly<Record<BoxId, NonNullable<HostBox["records"]>["initial"]>>;

// @approved
//  Only an enabled Box is captured, so a disabled Box's records are not read
// or folded: turning off a Box whose fold throws keeps Generations working.
export const foldRecordStates = (db: BunSQLiteDatabase, selectedVariantIds: readonly number[], setups: BoxSetups, boxes: BoxStates, instances: BoxInstances): RecordStates =>
	Object.fromEntries([...serverBoxes()].flatMap(([id, { records }]) => {
		if (records === undefined || boxes[id] !== "enabled") return [];
		const slots = readRecordSlots(db, id, boxRecordSchema(id), instances[id], selectedVariantIds);
		return [[id, foldRecords<unknown, unknown, unknown>(records, setups[id], slots, selectedVariantIds)]];
	}));

const writeSlot = (db: BunSQLiteDatabase, id: BoxId, instance: string, variantId: number, slot: RecordSlot<BoxValue>): void => {
	const value = JSON.stringify(slot);
	db.insert(messageVariantDataTable)
		.values({ message_variant_id: variantId, namespace: boxReference(id), key: recordKey(instance), value })
		.onConflictDoUpdate({ target: [messageVariantDataTable.message_variant_id, messageVariantDataTable.namespace, messageVariantDataTable.key], set: { value } })
		.run();
};

/** @approved A successful digest clears the slot's error. */
export const writeAutomaticRecord = (db: BunSQLiteDatabase, id: BoxId, instance: string, variantId: number, record: BoxValue, source: string): void =>
	writeSlot(db, id, instance, variantId, { writer: slotOf(db, id, instance, variantId)?.writer, automatic: record, source });

/** @approved A failed digest keeps the slot's records, so a stale automatic result still folds. */
export const writeDigestError = (db: BunSQLiteDatabase, id: BoxId, instance: string, variantId: number, source: string, message: string): void =>
	writeSlot(db, id, instance, variantId, { ...slotOf(db, id, instance, variantId), error: { source, message } });

/** @approved Whether a digest already failed on exactly this text. */
export const hasDigestError = (slot: RecordSlot | undefined, content: string): boolean => slot?.error?.source === sha256(content);

/** @approved A Writer override replaces the effective value without touching the automatic result or the prose. */
export const writeWriterRecord = (db: BunSQLiteDatabase, id: BoxId, instance: string, variantId: number, record: BoxValue): void =>
	writeSlot(db, id, instance, variantId, { ...slotOf(db, id, instance, variantId), writer: record });

/** @approved Reset removes the Writer override; with no automatic result or error left the slot row goes away entirely. */
export const resetWriterRecord = (db: BunSQLiteDatabase, id: BoxId, instance: string, variantId: number): void => {
	const current = slotOf(db, id, instance, variantId);
	if (current === undefined || current.writer === undefined) return;
	if (current.automatic === undefined && current.error === undefined) {
		db.delete(messageVariantDataTable)
			.where(and(eq(messageVariantDataTable.message_variant_id, variantId), eq(messageVariantDataTable.namespace, boxReference(id)), eq(messageVariantDataTable.key, recordKey(instance))))
			.run();
		return;
	}
	writeSlot(db, id, instance, variantId, { automatic: current.automatic, source: current.source, error: current.error });
};

export const readVariantSeeds = (db: BunSQLiteDatabase, variantIds: readonly number[]): Map<number, string> =>
	variantIds.length === 0 ? new Map() : new Map(db
		.select({ variantId: messageVariantDataTable.message_variant_id, value: messageVariantDataTable.value })
		.from(messageVariantDataTable)
		.where(and(inArray(messageVariantDataTable.message_variant_id, [...variantIds]), eq(messageVariantDataTable.namespace, SEED_NAMESPACE), eq(messageVariantDataTable.key, SEED_KEY)))
		.all()
		.map((row) => [row.variantId, row.value]));
