import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { openDatabase } from "./database";
import { characterTable } from "./schema";

export const getCharacter = async (id: number, database?: Database) => {
	const connection = database ?? openDatabase();

	try {
		return drizzle(connection)
			.select()
			.from(characterTable)
			.where(eq(characterTable.id, id))
			.get();
	} finally {
		if (!database) {
			connection.close();
		}
	}
};
