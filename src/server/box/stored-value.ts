import { parseStoredBoxJson } from "./stored-json";
import type { Static, TSchema } from "@sinclair/typebox";
import { and, eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { conversationDataTable, libraryDataTable } from "../database/schema";
import { InvalidConversationCommandError } from "../conversation";
import { boxReference, type BoxId } from "../../shared/contract/box";
import { readBoxStates } from "./setup";

// @approved
//  One JSON value kept in library_data or conversation_data, guarded by its
// row's revision under ADR-0023. A value never written reads as `initial` at
// revision 0. Every write passes the revision it finds to the caller's guard
// first, so the caller decides which conflict a stale write presents as.
type Row = { value: string; revision: number } | undefined;
type Guard = (current: { revision: number }) => void;

export interface LibraryValueWrite {
	readonly namespace: string;
	readonly key: string;
	readonly value: string;
}

export interface ChatValueWrite {
	readonly key: string;
	readonly value: string;
}

const decode = <T extends TSchema>(row: Row, schema: T, initial: Static<T>, place: string): Static<T> & { revision: number } => {
	if (row === undefined) return Object.assign({}, initial, { revision: 0 });
	const value = parseStoredBoxJson(row.value, schema, place);
	return Object.assign({}, value, { revision: row.revision });
};

const libraryRow = (namespace: string, key: string) => and(eq(libraryDataTable.namespace, namespace), eq(libraryDataTable.key, key));

export const readLibraryValue = <T extends TSchema>(db: BunSQLiteDatabase, namespace: string, key: string, schema: T, initial: Static<T>) =>
	decode(db.select().from(libraryDataTable).where(libraryRow(namespace, key)).get(), schema, initial, `${namespace} ${key}`);

export const putLibraryValue = (db: BunSQLiteDatabase, write: LibraryValueWrite, guard: Guard) => {
	const current = db.select({ revision: libraryDataTable.revision }).from(libraryDataTable).where(libraryRow(write.namespace, write.key)).get() ?? { revision: 0 };
	guard(current);
	const revision = current.revision + 1;
	db.insert(libraryDataTable)
		.values({ namespace: write.namespace, key: write.key, value: write.value, revision })
		.onConflictDoUpdate({ target: [libraryDataTable.namespace, libraryDataTable.key], set: { value: write.value, revision } })
		.run();
};

const chatRow = (conversationId: number, namespace: string, key: string) =>
	and(eq(conversationDataTable.conversation_id, conversationId), eq(conversationDataTable.namespace, namespace), eq(conversationDataTable.key, key));

export const readChatValue = <T extends TSchema>(db: BunSQLiteDatabase, conversationId: number, box: BoxId, key: string, schema: T, initial: Static<T>) =>
	decode(db.select().from(conversationDataTable).where(chatRow(conversationId, boxReference(box), key)).get(), schema, initial, `Chat ${conversationId} ${boxReference(box)} ${key}`);

// @approved
//  Only a Box present in the Chat keeps Chat-scoped values: removing it clears
// its namespace, so a write while it is absent would outlive the instance.
export const putChatValue = (db: BunSQLiteDatabase, conversationId: number, box: BoxId, write: ChatValueWrite, guard: Guard) => {
	if (readBoxStates(db, conversationId)[box] === "absent") throw new InvalidConversationCommandError(`The ${box} Box is not in this Chat, so it keeps no data.`);
	const namespace = boxReference(box);
	const current = db.select({ revision: conversationDataTable.revision }).from(conversationDataTable).where(chatRow(conversationId, namespace, write.key)).get() ?? { revision: 0 };
	guard(current);
	const revision = current.revision + 1;
	db.insert(conversationDataTable)
		.values({ conversation_id: conversationId, namespace, key: write.key, value: write.value, revision })
		.onConflictDoUpdate({ target: [conversationDataTable.conversation_id, conversationDataTable.namespace, conversationDataTable.key], set: { value: write.value, revision } })
		.run();
};
