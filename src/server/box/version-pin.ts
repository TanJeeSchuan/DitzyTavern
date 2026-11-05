import { and, eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { BoxId } from "../../shared/contract/box";
import { conversationDataTable } from "../database/schema";

// @approved
//  The version of each versioned Box a Chat pins, one `conversation_data`
// row per Box under this namespace, keyed by the Box id. It lives outside
// the `box:<id>` lifecycle namespace, so removing the Box keeps it: the pin
// says which version interprets the Chat's history. Generic data commands
// refuse the namespace, and Fork copies it with the rest of the Chat's data.
export const BOX_VERSION_NAMESPACE = "box-version";

/** @approved The version each versioned Box this Chat ever held is pinned to, by Box id. */
export const readBoxVersions = (db: BunSQLiteDatabase, conversationId: number): Readonly<Record<BoxId, string>> =>
	Object.fromEntries(db.select({ key: conversationDataTable.key, value: conversationDataTable.value }).from(conversationDataTable)
		.where(and(eq(conversationDataTable.conversation_id, conversationId), eq(conversationDataTable.namespace, BOX_VERSION_NAMESPACE)))
		.all().map(({ key, value }) => [key, value]));

/** @approved Pins `version` for a Chat's first insertion of the Box; a Chat that already pins one keeps it. */
export const pinFirstBoxVersion = (db: BunSQLiteDatabase, conversationId: number, id: BoxId, version: string): void => {
	db.insert(conversationDataTable).values({ conversation_id: conversationId, namespace: BOX_VERSION_NAMESPACE, key: id, value: version }).onConflictDoNothing().run();
};

/** @approved Pins `version` in place of any earlier pin, which only a passing upgrade does. */
export const pinBoxVersion = (db: BunSQLiteDatabase, conversationId: number, id: BoxId, version: string): void => {
	db.insert(conversationDataTable).values({ conversation_id: conversationId, namespace: BOX_VERSION_NAMESPACE, key: id, value: version })
		.onConflictDoUpdate({ target: [conversationDataTable.conversation_id, conversationDataTable.namespace, conversationDataTable.key], set: { value: version } }).run();
};
