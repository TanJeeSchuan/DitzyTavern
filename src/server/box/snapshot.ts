import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { BoxId } from "../../shared/contract/box";
import { assertChecked } from "../../shared/contract/box-descriptor";
import { snapshotQuery } from "../../shared/contract/box-sandboxed";
import { and, eq } from "drizzle-orm";
import { isActive } from "../database/is-active";
import { participantTable } from "../database/schema";
import { readCharacterRevisions, readLibraryValues, readParticipantValues } from "./stored-value";

/** @approved A sandboxed Box's `snapshot`, bound to the Box and to one Chat, inside the read transaction it serves: it takes a query as JSON and answers with JSON. */
export const boxSnapshot = (db: BunSQLiteDatabase, box: BoxId, conversationId: number) => (json: string): string => {
	const query: unknown = JSON.parse(json);
	assertChecked(snapshotQuery, query, `The ${box} Box's snapshot query`);
	const cast = db.select({ id: participantTable.id, sourceCharacterId: participantTable.source_character_id }).from(participantTable)
		.where(and(eq(participantTable.conversation_id, conversationId), isActive(participantTable))).all();
	switch (query.scope) {
		case "participant": return JSON.stringify(readParticipantValues(db, box, query.key, cast.map(({ id }) => id)));
		case "library": return JSON.stringify("prefix" in query ? readLibraryValues(db, box, query.prefix) : readLibraryValues(db, box, query.key).filter((row) => row.key === query.key));
		case "character": return JSON.stringify(readCharacterRevisions(db, box, query.key, cast.flatMap(({ sourceCharacterId }) => sourceCharacterId ?? [])));
	}
};
