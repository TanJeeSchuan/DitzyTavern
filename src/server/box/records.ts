import { parseStoredBoxJson } from "./stored-json";
import type { Static, TSchema } from "@sinclair/typebox";
import { and, eq, inArray } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { boxRecordSchema, boxReference, type BoxDescriptor, type BoxId, type BoxSetups } from "../../shared/contract/box";
import { type BoxValue } from "../../shared/contract/box-value";
import { boxRecordSlot, type DigestStatus, type SlotStatus } from "../../shared/contract/box-digest";
import { messageVariantDataTable } from "../database/schema";
import { sha256 } from "../hash";
import { SEED_KEY, SEED_NAMESPACE } from "./seed";
import type { participatingBoxes } from "./registry";
import type { HostBox } from "./contract";

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
			const slot = parseStoredBoxJson(row.value, schema, `Variant ${row.variantId} ${boxReference(id)} ${recordKey(instance)}`);
			return [row.variantId, slot];
		}));
};
const slotOf = (db: BunSQLiteDatabase, descriptor: BoxDescriptor, instance: string, variantId: number): RecordSlot<BoxValue> | undefined =>
	readRecordSlots(db, descriptor.id, boxRecordSchema(descriptor), instance, [variantId]).get(variantId);

/** @approved The effective value of one Box record slot: the writer's override, else the automatic result. */
export const effectiveRecord = <S extends RecordSlot>(slot: S | undefined): S["writer"] | S["automatic"] | undefined => slot?.writer ?? slot?.automatic;

// @approved
//  The slot's status for its passage's current text: `source` and `error`
//  each name the text they came from, so an edit makes the stored result
//  stale and an earlier failure no longer counts. A result for this text
//  wins over a failure on it.
export const slotStatus = (slot: RecordSlot | undefined, content: string): SlotStatus => {
	const hash = sha256(content);
	const automatic: DigestStatus = slot?.source === hash ? { kind: "fresh" }
		: slot?.error?.source === hash ? { kind: "failed", error: slot.error.message, stale: slot.source !== undefined }
		: slot?.source !== undefined ? { kind: "stale" } : { kind: "missing" };
	return slot?.writer === undefined ? automatic : { kind: "overridden", automatic };
};

// @approved
//  One Box version's record slots on the given Variants, for its instance,
// and its state: the fold over their effective records, in Message order,
// from `initial`, or undefined for a Box without a fold. A Box with
// `foldAll` gets every effective record in one call. Generation capture, the
// window reads and the digest status all fold this way.
export const readBoxFold = (db: BunSQLiteDatabase, { descriptor, box: { records } }: { readonly descriptor: BoxDescriptor; readonly box: HostBox }, instance: string | undefined, setup: BoxValue | undefined, variantIds: readonly number[]) => {
	const slots = records === undefined ? new Map<number, RecordSlot<BoxValue>>() : readRecordSlots(db, descriptor.id, boxRecordSchema(descriptor), instance, variantIds);
	const effective = variantIds.flatMap((variantId) => effectiveRecord(slots.get(variantId)) ?? []);
	const state = records?.fold === undefined ? undefined
		: records.foldAll === undefined ? effective.reduce((folded, record) => records.fold(folded, record, setup), records.initial)
		: records.foldAll(records.initial, effective, setup);
	return { slots, state };
};

/** @approved Each participating Box's slots on the Selected path and its state, by Box id, as one Generation captures them; only the Box that folded them reads them. */
export type BoxFolds = Readonly<Record<BoxId, ReturnType<typeof readBoxFold>>>;

// @approved
//  Only participating Boxes read and fold records for this Generation.
export const readBoxFolds = (db: BunSQLiteDatabase, selectedVariantIds: readonly number[], setups: BoxSetups, boxes: ReturnType<typeof participatingBoxes>): BoxFolds =>
	Object.fromEntries([...boxes].map(([id, box]) => [id, readBoxFold(db, box, box.instance, setups[id], selectedVariantIds)]));

const updateSlot = (db: BunSQLiteDatabase, descriptor: BoxDescriptor, instance: string, variantId: number, update: (slot: RecordSlot<BoxValue> | undefined) => RecordSlot<BoxValue> | undefined): void => {
	const { id } = descriptor;
	const current = slotOf(db, descriptor, instance, variantId);
	const next = update(current);
	if (next === current) return;
	if (next === undefined || (next.automatic === undefined && next.writer === undefined && next.error === undefined)) {
		db.delete(messageVariantDataTable)
			.where(and(eq(messageVariantDataTable.message_variant_id, variantId), eq(messageVariantDataTable.namespace, boxReference(id)), eq(messageVariantDataTable.key, recordKey(instance))))
			.run();
		return;
	}
	const value = JSON.stringify(next);
	db.insert(messageVariantDataTable)
		.values({ message_variant_id: variantId, namespace: boxReference(id), key: recordKey(instance), value })
		.onConflictDoUpdate({ target: [messageVariantDataTable.message_variant_id, messageVariantDataTable.namespace, messageVariantDataTable.key], set: { value } })
		.run();
};

/** @approved A successful digest clears the slot's error. */
export const writeAutomaticRecord = (db: BunSQLiteDatabase, descriptor: BoxDescriptor, instance: string, variantId: number, record: BoxValue, source: string): void =>
	updateSlot(db, descriptor, instance, variantId, (slot) => ({ writer: slot?.writer, automatic: record, source }));

/** @approved A failed digest keeps the slot's records, so a stale automatic result still folds. */
export const writeDigestError = (db: BunSQLiteDatabase, descriptor: BoxDescriptor, instance: string, variantId: number, source: string, message: string): void =>
	updateSlot(db, descriptor, instance, variantId, (slot) => ({ ...slot, error: { source, message } }));

/** @approved A Writer override replaces the effective value without touching the automatic result or the prose. */
export const writeWriterRecord = (db: BunSQLiteDatabase, descriptor: BoxDescriptor, instance: string, variantId: number, record: BoxValue): void =>
	updateSlot(db, descriptor, instance, variantId, (slot) => ({ ...slot, writer: record }));

/** @approved Reset removes the Writer override; with no automatic result or error left the slot row goes away entirely. */
export const resetWriterRecord = (db: BunSQLiteDatabase, descriptor: BoxDescriptor, instance: string, variantId: number): void =>
	updateSlot(db, descriptor, instance, variantId, (slot) => slot?.writer === undefined ? slot : { automatic: slot.automatic, source: slot.source, error: slot.error });

export const readVariantSeeds = (db: BunSQLiteDatabase, variantIds: readonly number[]): Map<number, string> =>
	variantIds.length === 0 ? new Map() : new Map(db
		.select({ variantId: messageVariantDataTable.message_variant_id, value: messageVariantDataTable.value })
		.from(messageVariantDataTable)
		.where(and(inArray(messageVariantDataTable.message_variant_id, [...variantIds]), eq(messageVariantDataTable.namespace, SEED_NAMESPACE), eq(messageVariantDataTable.key, SEED_KEY)))
		.all()
		.map((row) => [row.variantId, row.value]));
