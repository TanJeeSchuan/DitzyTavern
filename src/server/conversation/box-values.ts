import type { Database } from "bun:sqlite";
import { Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { and, eq, inArray, like, or, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { boxReference } from "../../shared/contract/box";
import type { GenerationJsonValue } from "../../shared/generation-json";
import { BOX_TRACES_KEY, BOX_TRACES_NAMESPACE } from "../../shared/variant-data-codecs";
import type { CheckedBox, StoredBoxValue } from "../box/contract";
import { isHostChatKey } from "../box/setup";
import {
	activeGenerationTable, conversationDataTable, conversationTable, generationReplayTable,
	messageDataTable, messageTable, messageVariantDataTable, messageVariantTable, participantDataTable, participantTable,
} from "../database/schema";
import { runConversationTransaction } from "./commands/transaction";
import { connectConversationDatabase, type ConversationDatabase } from "./internal";

const parsed = (text: string): GenerationJsonValue | undefined => {
	try { return JSON.parse(text); } catch { return undefined; }
};
const HELD = Symbol("held");
const isObject = (value: GenerationJsonValue | undefined): value is { [key: string]: GenerationJsonValue } =>
	typeof value === "object" && value !== null && !Array.isArray(value);

// @approved
//  The value when it passes, else the Box's upgrade of it when that passes,
// else undefined. A Box declines a value by throwing or returning it as is.
const settle = ({ box }: CheckedBox, schema: TSchema, stored: StoredBoxValue): GenerationJsonValue | undefined => {
	if (Value.Check(schema, stored.value)) return stored.value;
	if (box.upgrade === undefined) return undefined;
	try {
		const upgraded = box.upgrade(stored);
		return Value.Check(schema, upgraded) ? upgraded : undefined;
	} catch {
		return undefined;
	}
};

// @approved
//  Checks one Box's stored values in one Chat against its current schemas.
// A failing value the Box upgrades is rewritten. A failing automatic record
// or trace is derived, so it is deleted: a catch-up digests the passage
// again, and the Generation keeps its budget evidence without the trace.
// Anything else a person wrote, so it is held, its place returned, unless
// `clear` deletes it. A Chat whose values changed advances its revision.
const checkChat = (db: ConversationDatabase, conversationId: number, checked: CheckedBox, clear: boolean) => {
	const { descriptor, box } = checked;
	const namespace = boxReference(checked.id);
	const held: string[] = [];
	const touchedVariantIds = new Set<number>();
	let changed = false;
	const authored = (next: GenerationJsonValue | undefined, place: string): GenerationJsonValue | undefined | typeof HELD => {
		if (next !== undefined || clear) return next;
		held.push(place);
		return HELD;
	};
	const store = (current: GenerationJsonValue | undefined, next: GenerationJsonValue | undefined | typeof HELD, write: (value: string | undefined) => void) => {
		if (next === HELD || (next !== undefined && JSON.stringify(next) === JSON.stringify(current))) return;
		write(next === undefined ? undefined : JSON.stringify(next));
		changed = true;
	};

	for (const row of db.select().from(conversationDataTable).where(and(eq(conversationDataTable.conversation_id, conversationId), eq(conversationDataTable.namespace, namespace))).all()) {
		const setup = row.key === "setup";
		const schema = setup ? descriptor.setup?.schema : isHostChatKey(row.key) ? undefined : descriptor.values?.chat?.[row.key];
		if (schema === undefined) continue;
		const value = parsed(row.value);
		const place = setup ? `Chat ${conversationId} setup` : `Chat ${conversationId} value ${row.key}`;
		const stored: StoredBoxValue | undefined = value === undefined ? undefined : setup ? { kind: "setup", value } : { kind: "chat", key: row.key, value };
		store(value, authored(stored && settle(checked, schema, stored), place), (next) => next === undefined
			? db.delete(conversationDataTable).where(eq(conversationDataTable.id, row.id)).run()
			: db.update(conversationDataTable).set({ value: next, revision: sql`${conversationDataTable.revision} + 1` }).where(eq(conversationDataTable.id, row.id)).run());
	}

	const participants = db.select({ id: participantTable.id }).from(participantTable).where(eq(participantTable.conversation_id, conversationId)).all().map(({ id }) => id);
	const participantRows = participants.length === 0 ? [] : db.select().from(participantDataTable)
		.where(and(inArray(participantDataTable.participant_id, participants), eq(participantDataTable.namespace, namespace))).all();
	for (const row of participantRows) {
		const schema = descriptor.values?.participant?.[row.key];
		if (schema === undefined) continue;
		const value = parsed(row.value);
		const place = `Participant ${row.participant_id} value ${row.key}`;
		store(value, authored(value === undefined ? undefined : settle(checked, schema, { kind: "participant", key: row.key, value }), place), (next) => next === undefined
			? db.delete(participantDataTable).where(eq(participantDataTable.id, row.id)).run()
			: db.update(participantDataTable).set({ value: next }).where(eq(participantDataTable.id, row.id)).run());
	}

	const messages = db.select({ id: messageTable.id }).from(messageTable).where(eq(messageTable.conversation_id, conversationId)).all().map(({ id }) => id);
	const { moves, record } = descriptor;
	if (moves !== undefined && messages.length > 0) {
		const list = Type.Array(moves.schema, { minItems: 1, maxItems: moves.max });
		for (const row of db.select().from(messageDataTable).where(and(inArray(messageDataTable.message_id, messages), eq(messageDataTable.namespace, namespace), eq(messageDataTable.key, "moves"))).all()) {
			const value = parsed(row.value);
			const place = `Message ${row.message_id} Moves`;
			const each = Array.isArray(value) ? value.map((move) => settle(checked, moves.schema, { kind: "move", value: move })) : [];
			const settled = each.filter((move) => move !== undefined);
			store(value, authored(settled.length === each.length && Value.Check(list, settled) ? settled : undefined, place), (written) => written === undefined
				? db.delete(messageDataTable).where(eq(messageDataTable.id, row.id)).run()
				: db.update(messageDataTable).set({ value: written }).where(eq(messageDataTable.id, row.id)).run());
		}
	}

	const variants = messages.length === 0 ? [] : db.select({ id: messageVariantTable.id }).from(messageVariantTable).where(inArray(messageVariantTable.message_id, messages)).all().map(({ id }) => id);
	// @approved
	//  Trace rows run to megabytes per Chat, so only those naming the Box are read.
	const named = (column: SQLiteColumn) => sql`instr(${column}, ${JSON.stringify(namespace)}) > 0`;
	const variantRows = variants.length === 0 ? [] : db.select().from(messageVariantDataTable).where(and(inArray(messageVariantDataTable.message_variant_id, variants), or(
		and(eq(messageVariantDataTable.namespace, namespace), like(messageVariantDataTable.key, "record:%")),
		and(eq(messageVariantDataTable.namespace, BOX_TRACES_NAMESPACE), eq(messageVariantDataTable.key, BOX_TRACES_KEY), named(messageVariantDataTable.value)),
	))).all();
	const writeVariantRow = (row: (typeof variantRows)[number]) => (next: string | undefined) => {
		touchedVariantIds.add(row.message_variant_id);
		if (next === undefined) db.delete(messageVariantDataTable).where(eq(messageVariantDataTable.id, row.id)).run();
		else db.update(messageVariantDataTable).set({ value: next }).where(eq(messageVariantDataTable.id, row.id)).run();
	};
	if (record !== undefined) for (const row of variantRows.filter((row) => row.namespace === namespace && row.key.startsWith("record:"))) {
		const slot = parsed(row.value);
		const place = `Variant ${row.message_variant_id} record`;
		const part = (key: "automatic" | "writer") => isObject(slot) && slot[key] !== undefined
			? settle(checked, record, { kind: "record", value: slot[key] }) : undefined;
		if (!isObject(slot)) { store(slot, authored(undefined, place), writeVariantRow(row)); continue; }
		const automatic = part("automatic");
		const writer = slot.writer === undefined ? undefined : authored(part("writer"), `${place} writer`);
		const parts = { ...slot, automatic, source: slot.automatic !== undefined && automatic === undefined ? undefined : slot.source, writer: writer === HELD ? slot.writer : writer };
		const next = Object.fromEntries(Object.entries(parts).filter((entry): entry is [string, GenerationJsonValue] => entry[1] !== undefined));
		store(slot, next.automatic === undefined && next.writer === undefined && next.error === undefined ? undefined : next, writeVariantRow(row));
	}

	// @approved
	//  A trace is derived evidence, so one that fails and does not upgrade is
	// dropped from its Box's entry, wherever a Generation keeps its traces.
	const traceOf = (text: string): string | undefined => {
		const traces = parsed(text);
		const entry = isObject(traces) ? traces[namespace] : undefined;
		if (!isObject(traces) || !isObject(entry) || entry.trace === undefined) return undefined;
		const trace = box.advance?.trace === undefined ? undefined : settle(checked, box.advance.trace, { kind: "trace", value: entry.trace });
		const next = JSON.stringify({ ...traces, [namespace]: { ...entry, trace } });
		return next === JSON.stringify(traces) ? undefined : next;
	};
	for (const row of variantRows.filter((row) => row.namespace === BOX_TRACES_NAMESPACE && row.key === BOX_TRACES_KEY)) {
		const fixed = traceOf(row.value);
		if (fixed !== undefined) { writeVariantRow(row)(fixed); changed = true; }
	}
	for (const table of [activeGenerationTable, generationReplayTable]) {
		const rows = db.select({ id: table.id, traces: table.box_traces_json }).from(table).where(and(eq(table.conversation_id, conversationId), named(table.box_traces_json))).all();
		for (const row of rows) {
			const fixed = traceOf(row.traces);
			if (fixed !== undefined) { db.update(table).set({ box_traces_json: fixed }).where(eq(table.id, row.id)).run(); changed = true; }
		}
	}

	if (changed) db.update(conversationTable).set({ revision: sql`${conversationTable.revision} + 1` }).where(eq(conversationTable.id, conversationId)).run();
	return { held, changed, touchedVariantIds: [...touchedVariantIds] };
};


// @approved
//  Checks a Box's stored values in every Chat, one Chat write each, and
// returns the places it held. Nothing observes writes while the server
// loads, so only a clear reports its Chats' changes, which lets the digest
// queue see the records it dropped.
export const checkBoxValuesInChats = (database: Database, checked: CheckedBox, clear: boolean): string[] =>
	connectConversationDatabase(database).select({ id: conversationTable.id }).from(conversationTable).all().flatMap(({ id: conversationId }) =>
		runConversationTransaction(database, (db, reportChange) => {
			const { held, changed, touchedVariantIds } = checkChat(db, conversationId, checked, clear);
			if (changed && clear) reportChange({ conversationId, touchedVariantIds, removedVariantIds: [] });
			return held;
		}));
