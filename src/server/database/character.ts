import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { withDatabase } from "./database";
import { characterTable } from "./schema";

export const getCharacter = async (id: number, database?: Database) =>
	withDatabase(database, (connection) =>
		drizzle(connection)
			.select()
			.from(characterTable)
			.where(eq(characterTable.id, id))
			.get(),
	);

export const getCharacters = (database?: Database) =>
	withDatabase(database, (connection) =>
		drizzle(connection).select().from(characterTable).all(),
	);
