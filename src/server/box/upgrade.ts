/* eslint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- The check reads stored Box values as whatever JSON they hold and walks TypeBox schemas. */
import { KindGuard, Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { and, eq, inArray, like } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { boxReference, type BoxDescriptor } from "../../shared/contract/box";
import { ParticipantKey } from "../../shared/contract/box-row-reference";
import { conversationDataTable, messageDataTable, messageTable, messageVariantDataTable, messageVariantTable, participantDataTable, participantTable } from "../database/schema";
import type { LoadedBox } from "./registry";
import { holdsRowReferences } from "./row-references";
import { isHostChatKey } from "./setup";

const parsed = (text: string): unknown => {
	try { return JSON.parse(text); } catch { return undefined; }
};
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const rowKinds: ReadonlySet<unknown> = new Set(["message", "variant", "participant"]);

// @approved
//  Every place in a schema where Fork remaps a row id, by path: each
// `rowReference` annotation, and each Record keyed by `ParticipantKey`, whose
// keys Fork remaps though TypeBox keeps no annotation on them. The walk
// follows the one Fork's rewrite takes (`row-references.ts`), so two schemas
// with the same places have their ids remapped alike.
const remappedPlaces = (schema: TSchema | undefined, path: string): string[] => {
	if (schema === undefined || !holdsRowReferences(schema)) return [];
	const here = rowKinds.has(schema.rowReference) ? [`${path} (${String(schema.rowReference)})`] : [];
	if (KindGuard.IsUnion(schema)) return [...here, ...schema.anyOf.flatMap((branch, index) => remappedPlaces(branch, `${path}|${index}`))];
	if (KindGuard.IsArray(schema)) return [...here, ...remappedPlaces(schema.items, `${path}/*`)];
	if (KindGuard.IsObject(schema)) {
		const rest = KindGuard.IsSchema(schema.additionalProperties) ? remappedPlaces(schema.additionalProperties, `${path}/*`) : [];
		return [...here, ...Object.entries(schema.properties).flatMap(([key, property]) => remappedPlaces(property, `${path}/${key}`)), ...rest];
	}
	if (KindGuard.IsRecord(schema)) {
		const [pattern, item] = Object.entries(schema.patternProperties)[0] ?? [];
		return [...here, ...pattern === ParticipantKey.pattern ? [`${path}/{key} (participant key)`] : [], ...remappedPlaces(item, `${path}/{key}`)];
	}
	return here;
};
/** @approved Every place a version's schemas name a row Fork remaps. */
export const remappedRowPlaces = ({ setup, values, record, moves }: BoxDescriptor): string[] => [
	...remappedPlaces(setup?.schema, "setup"),
	...Object.entries(values?.chat ?? {}).flatMap(([key, schema]) => remappedPlaces(schema, `chat value ${key}`)),
	...Object.entries(values?.participant ?? {}).flatMap(([key, schema]) => remappedPlaces(schema, `participant value ${key}`)),
	...remappedPlaces(record, "record"),
	...remappedPlaces(moves?.schema, "Move"),
];

// @approved
//  Checks a Chat's stored data for one Box against version `to`, writing
// nothing, and returns each place that fails, or none: every record slot of
// the Box on every Variant, automatic and writer, of every instance, since
// the pin interprets the whole history; every Move list against the Move
// schema and its `max`; records or Moves that `to` would no longer declare;
// the stored setup against the setup schema and `setupError`; each Chat and
// Participant value against its declared schema; and every place Fork
// remaps an id, which must be identical in both versions. It checks each
// stored item, not each fold a later selection could produce.
export const upgradeRefusals = (db: BunSQLiteDatabase, conversationId: number, from: LoadedBox, to: LoadedBox): string[] => {
	const { descriptor, box } = to;
	const namespace = boxReference(descriptor.id);
	const refusals: string[] = [];
	const messages = db.select({ id: messageTable.id }).from(messageTable).where(eq(messageTable.conversation_id, conversationId)).all().map(({ id }) => id);
	const variants = messages.length === 0 ? [] : db.select({ id: messageVariantTable.id }).from(messageVariantTable).where(inArray(messageVariantTable.message_id, messages)).all().map(({ id }) => id);

	const slots = variants.length === 0 ? [] : db.select().from(messageVariantDataTable)
		.where(and(inArray(messageVariantDataTable.message_variant_id, variants), eq(messageVariantDataTable.namespace, namespace), like(messageVariantDataTable.key, "record:%"))).all();
	if (slots.length > 0 && descriptor.record === undefined) refusals.push(`The Chat holds ${slots.length} record slots, and this version declares no record.`);
	else for (const { message_variant_id: variantId, value } of slots) {
		const slot = parsed(value);
		if (!isObject(slot)) refusals.push(`Variant ${variantId} record`);
		else for (const part of ["automatic", "writer"] as const) if (slot[part] !== undefined && !Value.Check(descriptor.record!, slot[part])) refusals.push(`Variant ${variantId} ${part} record`); // @approved No record schema refused above.
	}

	const moves = messages.length === 0 ? [] : db.select().from(messageDataTable)
		.where(and(inArray(messageDataTable.message_id, messages), eq(messageDataTable.namespace, namespace), eq(messageDataTable.key, "moves"))).all();
	if (moves.length > 0 && descriptor.moves === undefined) refusals.push(`The Chat holds Moves on ${moves.length} Messages, and this version declares no Moves.`);
	else if (descriptor.moves !== undefined) {
		const list = Type.Array(descriptor.moves.schema, { minItems: 1, maxItems: descriptor.moves.max });
		for (const { message_id: messageId, value } of moves) if (!Value.Check(list, parsed(value))) refusals.push(`Message ${messageId} Moves`);
	}

	for (const { key, value } of db.select().from(conversationDataTable).where(and(eq(conversationDataTable.conversation_id, conversationId), eq(conversationDataTable.namespace, namespace))).all()) {
		const stored = parsed(value);
		if (key === "setup") {
			if (descriptor.setup === undefined) refusals.push("Setup: this version takes none");
			else if (!Value.Check(descriptor.setup.schema, stored)) refusals.push("Setup");
			else {
				let error: string | undefined;
				// @approved
				// SAFETY: the stored setup passed this version's setup schema just above.
				try { error = box.setupError?.(stored as never, stored as never); } catch (thrown) { error = thrown instanceof Error ? thrown.message : String(thrown); }
				if (error !== undefined) refusals.push(`Setup: ${error}`);
			}
		} else if (!isHostChatKey(key)) {
			const schema = descriptor.values?.chat?.[key];
			if (schema === undefined || !Value.Check(schema, stored)) refusals.push(`Chat value ${key}${schema === undefined ? ": this version does not declare it" : ""}`);
		}
	}

	const participants = db.select({ id: participantTable.id }).from(participantTable).where(eq(participantTable.conversation_id, conversationId));
	for (const { participant_id: participantId, key, value } of db.select().from(participantDataTable).where(and(inArray(participantDataTable.participant_id, participants), eq(participantDataTable.namespace, namespace))).all()) {
		const schema = descriptor.values?.participant?.[key];
		if (schema === undefined || !Value.Check(schema, parsed(value))) refusals.push(`Participant ${participantId} value ${key}${schema === undefined ? ": this version does not declare it" : ""}`);
	}

	const before = new Set(remappedRowPlaces(from.descriptor));
	const after = new Set(remappedRowPlaces(descriptor));
	for (const place of before) if (!after.has(place)) refusals.push(`Row reference at ${place}: this version no longer has it, so Fork would stop remapping it`);
	for (const place of after) if (!before.has(place)) refusals.push(`Row reference at ${place}: this version adds it, so Fork would remap values that hold no id`);
	return refusals;
};
