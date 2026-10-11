import { Value } from "@sinclair/typebox/value";
import { and, eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { boxReference, type BoxSetups } from "../../shared/contract/box";
import { conversationDataTable } from "../database/schema";
import { authorNoteBox } from "./author-note";

const SETUP_KEY = "setup";

export const boxSetupEntry = <Id extends keyof BoxSetups>(id: Id, setup: BoxSetups[Id]) =>
	({ namespace: boxReference(id), key: SETUP_KEY, value: JSON.stringify(setup) });

const decodeSetup = <Id extends keyof BoxSetups>(id: Id, stored: string | undefined): BoxSetups[Id] => {
	const { schema, initial } = authorNoteBox.setup;
	if (stored === undefined) return initial;
	const setup: unknown = JSON.parse(stored);
	if (!Value.Check(schema, setup)) throw new Error(`The stored ${id} Box setup does not match its schema. Clear the ${boxReference(id)} namespace.`);
	// @approved
	//  SAFETY: Value.Check just verified the value against this Box's setup schema.
	return setup as BoxSetups[Id];
};

export const readBoxSetups = (db: BunSQLiteDatabase, conversationId: number): BoxSetups => {
	const stored = new Map(db
		.select({ namespace: conversationDataTable.namespace, value: conversationDataTable.value })
		.from(conversationDataTable)
		.where(and(eq(conversationDataTable.conversation_id, conversationId), eq(conversationDataTable.key, SETUP_KEY)))
		.all()
		.map((row) => [row.namespace, row.value]));
	return { "author-note": decodeSetup("author-note", stored.get(boxReference("author-note"))) };
};
