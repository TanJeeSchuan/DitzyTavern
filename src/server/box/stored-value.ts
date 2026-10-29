import { parseStoredBoxJson } from "./stored-json";
import type { Static, TSchema } from "@sinclair/typebox";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { characterDataTable, conversationDataTable, libraryDataTable, participantDataTable } from "../database/schema";
import { InvalidConversationCommandError } from "../conversation";
import { boxDescriptor, boxReference, type BoxId } from "../../shared/contract/box";
import { isHostChatKey, readBoxLifecycles } from "./setup";

// @approved
//  One JSON value kept in library_data or conversation_data, guarded by its
// row's revision under ADR-0023. A value never written reads as `initial` at
// revision 0. Every write passes the revision it finds to the caller's guard
// first, so the caller decides which conflict a stale write presents as. A
// Box-scoped read or write takes the Box's id and fixes the `box:<id>`
// namespace from it, so a Box names only an id, never a namespace or table.
type Row = { value: string; revision: number } | undefined;
type SharedGuard = (current: { readonly revision: number }) => void;
type ChatGuard = (current: { readonly revision: string }) => void;

export interface ValueWrite {
	readonly key: string;
	readonly value: string;
}

const chatRevision = (instance: string | undefined, revision: number): string => `${instance ?? "absent"}:${revision}`;

const decode = <T extends TSchema, Revision extends number | string>(row: Row, schema: T, initial: Static<T>, place: string, revision: Revision) =>
	Object.assign({}, row === undefined ? initial : parseStoredBoxJson(row.value, schema, place), { revision });

const libraryRow = (namespace: string, key: string) => and(eq(libraryDataTable.namespace, namespace), eq(libraryDataTable.key, key));

/** @approved A host value in library_data under its own namespace, such as a Decision Model selection. */
export const readNamespacedLibraryValue = <T extends TSchema>(db: BunSQLiteDatabase, namespace: string, key: string, schema: T, initial: Static<T>) => {
	const row = db.select().from(libraryDataTable).where(libraryRow(namespace, key)).get();
	return decode(row, schema, initial, `${namespace} ${key}`, row?.revision ?? 0);
};

export const putNamespacedLibraryValue = (db: BunSQLiteDatabase, namespace: string, write: ValueWrite, guard: SharedGuard) => {
	const current = db.select({ revision: libraryDataTable.revision }).from(libraryDataTable).where(libraryRow(namespace, write.key)).get() ?? { revision: 0 };
	guard(current);
	const revision = current.revision + 1;
	db.insert(libraryDataTable)
		.values({ namespace, key: write.key, value: write.value, revision })
		.onConflictDoUpdate({ target: [libraryDataTable.namespace, libraryDataTable.key], set: { value: write.value, revision } })
		.run();
};

export const readLibraryValue = <T extends TSchema>(db: BunSQLiteDatabase, box: BoxId, key: string, schema: T, initial: Static<T>) =>
	readNamespacedLibraryValue(db, boxReference(box), key, schema, initial);

export const putLibraryValue = (db: BunSQLiteDatabase, box: BoxId, write: ValueWrite, guard: SharedGuard) =>
	putNamespacedLibraryValue(db, boxReference(box), write, guard);

/** @approved The Box's Library values whose keys start with `prefix`, as stored, with their revisions. */
export const readLibraryValues = (db: BunSQLiteDatabase, box: BoxId, prefix: string) =>
	db.select({ key: libraryDataTable.key, value: libraryDataTable.value, revision: libraryDataTable.revision }).from(libraryDataTable)
		.where(and(eq(libraryDataTable.namespace, boxReference(box)), sql`instr(${libraryDataTable.key}, ${prefix}) = 1`)).all();

const characterRow = (characterId: number, box: BoxId, key: string) =>
	and(eq(characterDataTable.character_id, characterId), eq(characterDataTable.namespace, boxReference(box)), eq(characterDataTable.key, key));

/** @approved The revision of the Box's `key` value for each of `characterIds` that has one. */
export const readCharacterRevisions = (db: BunSQLiteDatabase, box: BoxId, key: string, characterIds: readonly number[]) =>
	db.select({ characterId: characterDataTable.character_id, revision: characterDataTable.revision }).from(characterDataTable)
		.where(and(eq(characterDataTable.namespace, boxReference(box)), eq(characterDataTable.key, key), inArray(characterDataTable.character_id, [...characterIds]))).all();

export const putCharacterValue = (db: BunSQLiteDatabase, box: BoxId, characterId: number, write: ValueWrite, guard: SharedGuard) => {
	const current = db.select({ revision: characterDataTable.revision }).from(characterDataTable).where(characterRow(characterId, box, write.key)).get() ?? { revision: 0 };
	guard(current);
	const revision = current.revision + 1;
	db.insert(characterDataTable)
		.values({ character_id: characterId, namespace: boxReference(box), key: write.key, value: write.value, revision })
		.onConflictDoUpdate({ target: [characterDataTable.character_id, characterDataTable.namespace, characterDataTable.key], set: { value: write.value, revision } })
		.run();
};

/** @approved The Box's `key` value, as stored, for each of `participantIds` that has one. */
export const readParticipantValues = (db: BunSQLiteDatabase, box: BoxId, key: string, participantIds: readonly number[]) =>
	db.select({ participantId: participantDataTable.participant_id, value: participantDataTable.value }).from(participantDataTable)
		.where(and(eq(participantDataTable.namespace, boxReference(box)), eq(participantDataTable.key, key), inArray(participantDataTable.participant_id, [...participantIds]))).all();

/** @approved A Participant belongs to one Chat, whose revision guards its values, so the write carries no revision of its own. */
export const putParticipantValue = (db: BunSQLiteDatabase, box: BoxId, participantId: number, write: ValueWrite) => {
	requireDeclaredValueKey(box, "participant", write.key);
	db.insert(participantDataTable)
		.values({ participant_id: participantId, namespace: boxReference(box), key: write.key, value: write.value })
		.onConflictDoUpdate({ target: [participantDataTable.participant_id, participantDataTable.namespace, participantDataTable.key], set: { value: write.value } })
		.run();
};

const requireDeclaredValueKey = (box: BoxId, scope: "chat" | "participant", key: string): void => {
	const values = boxDescriptor(box).values?.[scope];
	if (values === undefined || !Object.hasOwn(values, key)) throw new InvalidConversationCommandError(`The ${box} Box has no declared ${scope} value for ${key}.`);
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
		const instance = readBoxLifecycles(tx, conversationId)[box]?.instance;
		return decode(row, schema, initial, `Chat ${conversationId} ${namespace} ${key}`, chatRevision(instance, row?.revision ?? 0));
	});
};

// @approved
//  Only a Box present in the Chat keeps Chat-scoped values: removing it clears
// its namespace, so a write while it is absent would outlive the instance.
export const putChatValue = (db: BunSQLiteDatabase, conversationId: number, box: BoxId, write: ValueWrite, guard: ChatGuard) => {
	requireBoxValueKey(write.key);
	requireDeclaredValueKey(box, "chat", write.key);
	const namespace = boxReference(box);
	db.transaction((tx) => {
		const instance = readBoxLifecycles(tx, conversationId)[box]?.instance;
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
