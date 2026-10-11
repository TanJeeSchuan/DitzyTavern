import { raceBox } from "./race";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { and, eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { boxIds, boxReference, type BoxId, type BoxSetups, type BoxStates } from "../../shared/contract/box";
import { conversationDataTable } from "../database/schema";
import { authorNoteBox } from "./author-note";
import { worldClockBox } from "./world-clock";

const SETUP_KEY = "setup";
const ENABLED_KEY = "enabled";

export const boxStateEntry = (id: BoxId, enabled: boolean) =>
	({ namespace: boxReference(id), key: ENABLED_KEY, value: JSON.stringify(enabled) });

export const readBoxStates = (db: BunSQLiteDatabase, conversationId: number): BoxStates => {
	const stored = new Map(db
		.select({ namespace: conversationDataTable.namespace, value: conversationDataTable.value })
		.from(conversationDataTable)
		.where(and(eq(conversationDataTable.conversation_id, conversationId), eq(conversationDataTable.key, ENABLED_KEY)))
		.all()
		.map((row) => [row.namespace, row.value]));
	// @approved
	// SAFETY: the entries cover every Box id exactly once.
	return Object.fromEntries(boxIds.map((id) => {
		const value = stored.get(boxReference(id));
		return [id, value === undefined ? "absent" : JSON.parse(value) === true ? "enabled" : "disabled"];
	})) as BoxStates;
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

export const boxSetupEntry = <Id extends keyof BoxSetups>(id: Id, setup: BoxSetups[Id]) =>
	({ namespace: boxReference(id), key: SETUP_KEY, value: JSON.stringify(setup) });

const decodeSetup = <Setup>(id: keyof BoxSetups, { schema, initial }: { readonly schema: TSchema; readonly initial: Setup }, stored: string | undefined): Setup => {
	if (stored === undefined) return initial;
	const setup: unknown = JSON.parse(stored);
	if (!Value.Check(schema, setup)) throw new Error(`The stored ${id} Box setup does not match its schema. Clear the ${boxReference(id)} namespace.`);
	// @approved
	//  SAFETY: Value.Check just verified the value against this Box's setup schema.
	return setup as Setup;
};

export const readBoxSetups = (db: BunSQLiteDatabase, conversationId: number): BoxSetups => {
	const stored = new Map(db
		.select({ namespace: conversationDataTable.namespace, value: conversationDataTable.value })
		.from(conversationDataTable)
		.where(and(eq(conversationDataTable.conversation_id, conversationId), eq(conversationDataTable.key, SETUP_KEY)))
		.all()
		.map((row) => [row.namespace, row.value]));
	return {
		race: decodeSetup("race", raceBox.setup, stored.get(boxReference("race"))),
		"author-note": decodeSetup("author-note", authorNoteBox.setup, stored.get(boxReference("author-note"))),
		"world-clock": decodeSetup("world-clock", worldClockBox.setup, stored.get(boxReference("world-clock"))),
	};
};
