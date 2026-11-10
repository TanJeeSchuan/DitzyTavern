/* eslint-disable anti-slop/no-runtime-typeof -- The check reads stored Box values as whatever JSON they hold and walks TypeBox schemas. */
import { KindGuard, Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { and, eq, inArray, like } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { boxReference, type BoxDescriptor, type BoxId } from "../../shared/contract/box";
import type { BoxValue } from "../../shared/contract/box-value";
import { ParticipantKey } from "../../shared/contract/box-row-reference";
import type { GenerationJsonValue } from "../../shared/generation-json";
import { openInitializedDatabase } from "../database/database";
import { conversationDataTable, conversationTable, messageDataTable, messageTable, messageVariantDataTable, messageVariantTable, participantDataTable, participantTable } from "../database/schema";
import type { LoadedBox } from "../box/registry";
import { holdsRowReferences } from "../box/row-references";
import { isHostChatKey } from "../box/setup";
import { sha256 } from "../hash";

const parsed = (text: string): BoxValue | undefined => {
	try { return JSON.parse(text); } catch { return undefined; }
};
const isObject = (value: BoxValue | undefined): value is { readonly [key: string]: BoxValue } => typeof value === "object" && value !== null && !Array.isArray(value);
const rowKinds: ReadonlySet<string> = new Set(["message", "variant", "participant"]);

// @approved
//  Every place in a schema where Fork remaps a row id, by path: each
// `rowReference` annotation, and each Record keyed by `ParticipantKey`, whose
// keys Fork remaps though TypeBox keeps no annotation on them. The walk
// follows the one Fork's rewrite takes (`row-references.ts`), so two schemas
// with the same places have their ids remapped alike. Keys are encoded, so a
// key holding `/` cannot name another field's path. Fork picks a union's
// branch by which one the stored value matches, not by position, so a union
// holding row references is also a place named by its whole schema: any
// change to it, reordering its branches included, refuses the upgrade.
const remappedPlaces = (schema: TSchema | undefined, path: string): string[] => {
	if (schema === undefined || !holdsRowReferences(schema)) return [];
	const reference = schema.rowReference;
	const here = typeof reference === "string" && rowKinds.has(reference) ? [`${path} (${reference})`] : [];
	if (KindGuard.IsUnion(schema)) return [...here, `${path} (union ${sha256(JSON.stringify(schema.anyOf)).slice(0, 12)})`, ...schema.anyOf.flatMap((branch, index) => remappedPlaces(branch, `${path}|${index}`))];
	if (KindGuard.IsArray(schema)) return [...here, ...remappedPlaces(schema.items, `${path}/*`)];
	if (KindGuard.IsObject(schema)) {
		const rest = KindGuard.IsSchema(schema.additionalProperties) ? remappedPlaces(schema.additionalProperties, `${path}/*`) : [];
		return [...here, ...Object.entries(schema.properties).flatMap(([key, property]) => remappedPlaces(property, `${path}/${encodeURIComponent(key)}`)), ...rest];
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
	...Object.entries(values?.chat ?? {}).flatMap(([key, schema]) => remappedPlaces(schema, `chat value ${encodeURIComponent(key)}`)),
	...Object.entries(values?.participant ?? {}).flatMap(([key, schema]) => remappedPlaces(schema, `participant value ${encodeURIComponent(key)}`)),
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
// stored item, not each fold a later selection could produce. Creator Mode
// runs it on a scenario's data in a database of its own.
export const upgradeRefusals = (db: BunSQLiteDatabase, conversationId: number, from: Pick<LoadedBox, "descriptor">, to: Pick<LoadedBox, "descriptor" | "box">): string[] => {
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
				try { error = box.setupError?.(stored, stored); } catch (thrown) { error = thrown instanceof Error ? thrown.message : String(thrown); }
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

/** @approved The refusal a writer's Update reads, and a scenario `from` an earlier version reads alike. */
export const refusedUpgrade = (label: string, refusals: readonly string[]) => `The ${label} Box cannot move to that version. These no longer fit:\n${refusals.join("\n")}`;

/** @approved One scenario turn as a Chat would store it: the human's Moves, and the record of each Variant its passage got, in the order they ran; the last is selected. */
export type PlayedTurn = { readonly moves: readonly BoxValue[]; readonly records: readonly (GenerationJsonValue | undefined)[] };

// @approved
//  Writes what a scenario's turns left into a fresh in-memory database laid
// out as the app's, one Chat with the scenario's Cast, then runs the
// writer's Update check on it, so the refusals read exactly as an Update of
// that Chat would. The app's own database is never opened. The setup is
// stored only when the scenario names one, as a Chat stores it only once the
// writer saves one.
export const playedRefusals = (id: BoxId, cast: readonly { readonly id: number; readonly name: string }[], setup: BoxValue | undefined, played: readonly PlayedTurn[], from: Pick<LoadedBox, "descriptor">, to: Pick<LoadedBox, "descriptor" | "box">): string[] => {
	const database = openInitializedDatabase({ path: ":memory:" });
	try {
		const db = drizzle(database);
		const namespace = boxReference(id);
		const time = new Date(0).toISOString();
		const { id: chat } = db.insert(conversationTable).values({ name: "Scenario", creation_time: time, last_message_time: time }).returning({ id: conversationTable.id }).get();
		db.insert(participantTable).values(cast.map((member, index) => ({ id: member.id, conversation_id: chat, name: member.name, position: index + 1 }))).run();
		const human = cast[0]!.id; // @approved The input schema requires at least one Cast member.
		const speaker = cast[1]?.id ?? human;
		if (setup !== undefined) db.insert(conversationDataTable).values({ conversation_id: chat, namespace, key: "setup", value: JSON.stringify(setup) }).run();
		for (const [index, { moves, records }] of played.entries()) {
			const [asked, passage] = [index * 2 + 1, index * 2 + 2];
			db.insert(messageTable).values([
				{ id: asked, conversation_id: chat, position: index * 2, timestamp: time, author_participant_id: human },
				{ id: passage, conversation_id: chat, position: index * 2 + 1, timestamp: time, author_participant_id: speaker },
			]).run();
			if (moves.length > 0) db.insert(messageDataTable).values({ message_id: asked, namespace, key: "moves", value: JSON.stringify(moves) }).run();
			for (const [position, record] of records.entries()) {
				const { id: variant } = db.insert(messageVariantTable).values({ message_id: passage, position, content: "", timestamp: time, selected: position === records.length - 1 }).returning({ id: messageVariantTable.id }).get();
				if (record !== undefined) db.insert(messageVariantDataTable).values({ message_variant_id: variant, namespace, key: "record:scenario", value: JSON.stringify({ automatic: record }) }).run();
			}
		}
		return upgradeRefusals(db, chat, from, to);
	} finally {
		database.close();
	}
};
