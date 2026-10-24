import { parseStoredBoxJson } from "./stored-json";
import type { Static, TSchema } from "@sinclair/typebox";
import { and, eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { conversationDataTable, libraryDataTable } from "../database/schema";
import { InvalidConversationCommandError } from "../conversation";
import { boxReference, type BoxId } from "../../shared/contract/box";
import { isHostChatKey, readBoxInstance } from "./setup";

// @approved
//  One JSON value kept in library_data or conversation_data, guarded by its
// row's revision under ADR-0023. A value never written reads as `initial` at
// revision 0. Every write passes the revision it finds to the caller's guard
// first, so the caller decides which conflict a stale write presents as.
type Row = { value: string; revision: number } | undefined;
type LibraryGuard = (current: { readonly revision: number }) => void;
type ChatGuard = (current: { readonly revision: string }) => void;

export interface LibraryValueWrite {
	readonly namespace: string;
	readonly key: string;
	readonly value: string;
}

export interface ChatValueWrite {
	readonly key: string;
	readonly value: string;
}

const chatRevision = (instance: string | undefined, revision: number): string => `${instance ?? "absent"}:${revision}`;

const decode = <T extends TSchema, Revision extends number | string>(row: Row, schema: T, initial: Static<T>, place: string, revision: Revision) =>
	Object.assign({}, row === undefined ? initial : parseStoredBoxJson(row.value, schema, place), { revision });

const libraryRow = (namespace: string, key: string) => and(eq(libraryDataTable.namespace, namespace), eq(libraryDataTable.key, key));

export const readLibraryValue = <T extends TSchema>(db: BunSQLiteDatabase, namespace: string, key: string, schema: T, initial: Static<T>) => {
	const row = db.select().from(libraryDataTable).where(libraryRow(namespace, key)).get();
	return decode(row, schema, initial, `${namespace} ${key}`, row?.revision ?? 0);
};

export const putLibraryValue = (db: BunSQLiteDatabase, write: LibraryValueWrite, guard: LibraryGuard) => {
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

const requireBoxValueKey = (key: string): void => {
	if (isHostChatKey(key)) throw new InvalidConversationCommandError(`The ${key} key belongs to the host, so a Box keeps no value under it.`);
};

export const readChatValue = <T extends TSchema>(db: BunSQLiteDatabase, conversationId: number, box: BoxId, key: string, schema: T, initial: Static<T>) => {
	requireBoxValueKey(key);
	const namespace = boxReference(box);
	return db.transaction((tx) => {
		const row = tx.select().from(conversationDataTable).where(chatRow(conversationId, namespace, key)).get();
		const instance = readBoxInstance(tx, conversationId, box);
		return decode(row, schema, initial, `Chat ${conversationId} ${namespace} ${key}`, chatRevision(instance, row?.revision ?? 0));
	});
};

// @approved
//  Only a Box present in the Chat keeps Chat-scoped values: removing it clears
// its namespace, so a write while it is absent would outlive the instance.
export const putChatValue = (db: BunSQLiteDatabase, conversationId: number, box: BoxId, write: ChatValueWrite, guard: ChatGuard) => {
	requireBoxValueKey(write.key);
	const namespace = boxReference(box);
	db.transaction((tx) => {
		const instance = readBoxInstance(tx, conversationId, box);
		if (instance === undefined) throw new InvalidConversationCommandError(`The ${box} Box is not in this Chat, so it keeps no data.`);
		const current = tx.select({ revision: conversationDataTable.revision }).from(conversationDataTable).where(chatRow(conversationId, namespace, write.key)).get() ?? { revision: 0 };
		guard({ revision: chatRevision(instance, current.revision) });
		const revision = current.revision + 1;
		tx.insert(conversationDataTable)
			.values({ conversation_id: conversationId, namespace, key: write.key, value: write.value, revision })
			.onConflictDoUpdate({ target: [conversationDataTable.conversation_id, conversationDataTable.namespace, conversationDataTable.key], set: { value: write.value, revision } })
			.run();
	});
};
