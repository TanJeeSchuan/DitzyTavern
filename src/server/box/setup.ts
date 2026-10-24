import { parseStoredBoxJson } from "./stored-json";
import { Type } from "@sinclair/typebox";
import { and, eq, inArray } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { boxDescriptors, boxesWith, boxReference, type BoxId, type BoxSetups, type BoxStates } from "../../shared/contract/box";
import type { BoxValue } from "../../shared/contract/box-value";
import { conversationDataTable } from "../database/schema";

const SETUP_KEY = "setup";
const ENABLED_KEY = "enabled";
const INSTANCE_KEY = "instance";

const hostChatKeys: ReadonlySet<string> = new Set([SETUP_KEY, ENABLED_KEY, INSTANCE_KEY]);
export const isHostChatKey = (key: string): boolean => hostChatKeys.has(key);

const storedBoolean = Type.Boolean();

export const boxStateEntry = (id: BoxId, enabled: boolean) =>
	({ namespace: boxReference(id), key: ENABLED_KEY, value: JSON.stringify(enabled) });

// @approved
//  Each insert gives the Box a new instance, kept while it is disabled and
// deleted with the rest of its Chat-scoped data on removal. Records are
// stamped with it, so a reinserted Box folds none of its earlier records.
export const boxInstanceEntry = (id: BoxId) =>
	({ namespace: boxReference(id), key: INSTANCE_KEY, value: crypto.randomUUID() });

export type BoxLifecycles = Readonly<Record<BoxId, { readonly state: "enabled" | "disabled"; readonly instance: string }>>;

/** @approved Each loaded Box present in this Chat, with its state and insertion instance read together. */
export const readBoxLifecycles = (db: BunSQLiteDatabase, conversationId: number): BoxLifecycles => {
	const stored = Map.groupBy(db
		.select({ namespace: conversationDataTable.namespace, key: conversationDataTable.key, value: conversationDataTable.value })
		.from(conversationDataTable)
		.where(and(eq(conversationDataTable.conversation_id, conversationId), inArray(conversationDataTable.key, [ENABLED_KEY, INSTANCE_KEY])))
		.all(), ({ namespace }) => namespace);
	return Object.fromEntries([...boxDescriptors().keys()].flatMap((id) => {
		const rows = stored.get(boxReference(id));
		if (rows === undefined) return [];
		const enabled = rows.find(({ key }) => key === ENABLED_KEY)?.value;
		const instance = rows.find(({ key }) => key === INSTANCE_KEY)?.value;
		if (enabled === undefined || instance === undefined) throw new Error(`Stored Box lifecycle at Chat ${conversationId} ${boxReference(id)} needs both enabled and instance.`);
		const parsed = parseStoredBoxJson(enabled, storedBoolean, `Chat ${conversationId} ${boxReference(id)} ${ENABLED_KEY}`);
		return [[id, { state: parsed ? "enabled" : "disabled", instance }]];
	}));
};

export const readBoxStates = (db: BunSQLiteDatabase, conversationId: number): BoxStates => {
	const lifecycles = readBoxLifecycles(db, conversationId);
	return Object.fromEntries([...boxDescriptors().keys()].map((id) => [id, lifecycles[id]?.state ?? "absent"]));
};

/** @approved The Chats where the Box is enabled, as a subquery for background work that spans Chats. */
export const enabledBoxConversations = (db: BunSQLiteDatabase, id: BoxId) =>
	db.select({ id: conversationDataTable.conversation_id }).from(conversationDataTable)
		.where(and(eq(conversationDataTable.namespace, boxReference(id)), eq(conversationDataTable.key, ENABLED_KEY), eq(conversationDataTable.value, "true")));

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
		const decoded = parseStoredBoxJson(value, Type.Unsafe<BoxValue>(schema), `Chat ${conversationId} ${boxReference(id)} ${SETUP_KEY}`);
		return [id, decoded];
	}));
};
