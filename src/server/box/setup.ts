import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { and, eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { boxDescriptors, boxesWith, boxReference, isBoxReference, type BoxId, type BoxSetups, type BoxStates } from "../../shared/contract/box";
import type { BoxValue } from "../../shared/contract/box-value";
import { conversationDataTable } from "../database/schema";

const SETUP_KEY = "setup";
const ENABLED_KEY = "enabled";
const INSTANCE_KEY = "instance";

const storedBoolean = Type.Boolean();

export const boxStateEntry = (id: BoxId, enabled: boolean) =>
	({ namespace: boxReference(id), key: ENABLED_KEY, value: JSON.stringify(enabled) });

// @approved
//  Each insert gives the Box a new instance, kept while it is disabled and
// deleted with the rest of its Chat-scoped data on removal. Records are
// stamped with it, so a reinserted Box folds none of its earlier records.
export const boxInstanceEntry = (id: BoxId) =>
	({ namespace: boxReference(id), key: INSTANCE_KEY, value: crypto.randomUUID() });

export type BoxInstances = Partial<Record<BoxId, string>>;

/** @approved The instance of every Box present in this Chat; an absent Box has none. */
export const readBoxInstances = (db: BunSQLiteDatabase, conversationId: number): BoxInstances => Object.fromEntries(db
	.select({ namespace: conversationDataTable.namespace, value: conversationDataTable.value })
	.from(conversationDataTable)
	.where(and(eq(conversationDataTable.conversation_id, conversationId), eq(conversationDataTable.key, INSTANCE_KEY)))
	.all()
	.flatMap(({ namespace, value }) => isBoxReference(namespace) ? [[namespace.slice("box:".length), value]] : []));

export const readBoxStates = (db: BunSQLiteDatabase, conversationId: number): BoxStates => {
	const stored = new Map(db
		.select({ namespace: conversationDataTable.namespace, value: conversationDataTable.value })
		.from(conversationDataTable)
		.where(and(eq(conversationDataTable.conversation_id, conversationId), eq(conversationDataTable.key, ENABLED_KEY)))
		.all()
		.map((row) => [row.namespace, row.value]));
	return Object.fromEntries([...boxDescriptors().keys()].map((id) => {
		const value = stored.get(boxReference(id));
		if (value === undefined) return [id, "absent"];
		const parsed: unknown = JSON.parse(value);
		if (!Value.Check(storedBoolean, parsed)) throw new Error(`Stored ${boxReference(id)} enablement is not a boolean. Clear the ${boxReference(id)} namespace.`);
		return [id, parsed ? "enabled" : "disabled"];
	}));
};

/** @approved The Boxes On in this Chat. */
export const enabledBoxIds = (db: BunSQLiteDatabase, conversationId: number): BoxId[] => {
	const states = readBoxStates(db, conversationId);
	return [...boxDescriptors().keys()].filter((id) => states[id] === "enabled");
};

/** @approved The Chats where the Box is enabled, as a subquery for background work that spans Chats. */
export const enabledBoxConversations = (db: BunSQLiteDatabase, id: BoxId) =>
	db.select({ id: conversationDataTable.conversation_id }).from(conversationDataTable)
		.where(and(eq(conversationDataTable.namespace, boxReference(id)), eq(conversationDataTable.key, ENABLED_KEY), eq(conversationDataTable.value, "true")));

/** @approved Whether the Box runs in this Chat: only an enabled Box captures, digests or accepts Moves. */
export const isBoxEnabled = (db: BunSQLiteDatabase, conversationId: number, id: BoxId): boolean =>
	db.select({ value: conversationDataTable.value }).from(conversationDataTable)
		.where(and(eq(conversationDataTable.conversation_id, conversationId), eq(conversationDataTable.namespace, boxReference(id)), eq(conversationDataTable.key, ENABLED_KEY)))
		.get()?.value === "true";

export const boxSetupEntry = (id: BoxId, setup: BoxValue) =>
	({ namespace: boxReference(id), key: SETUP_KEY, value: JSON.stringify(setup) });

export const readBoxSetups = (db: BunSQLiteDatabase, conversationId: number): BoxSetups => {
	const stored = new Map(db
		.select({ namespace: conversationDataTable.namespace, value: conversationDataTable.value })
		.from(conversationDataTable)
		.where(and(eq(conversationDataTable.conversation_id, conversationId), eq(conversationDataTable.key, SETUP_KEY)))
		.all()
		.map((row) => [row.namespace, row.value]));
	return Object.fromEntries(boxesWith("setup").map(([id, { schema, initial }]) => {
		const value = stored.get(boxReference(id));
		if (value === undefined) return [id, initial];
		const decoded: BoxValue = JSON.parse(value);
		if (!Value.Check(schema, decoded)) throw new Error(`The stored ${id} Box setup does not match its schema. Clear the ${boxReference(id)} namespace.`);
		return [id, decoded];
	}));
};
