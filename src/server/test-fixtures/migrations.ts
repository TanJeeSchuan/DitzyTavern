import { Database } from "bun:sqlite";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initializeDatabase } from "../database/database";
import journal from "../database/migrations/meta/_journal.json";

export async function migrateThrough(database: Database, index: number): Promise<void> {
	const scratch = join(process.cwd(), ".scratch");
	await mkdir(scratch, { recursive: true });
	const folder = await mkdtemp(join(scratch, "migration-"));
	try {
		await cp(join(import.meta.dir, "../database/migrations"), folder, { recursive: true });
		await writeFile(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.filter(({ idx }) => idx <= index) }));
		initializeDatabase(database, folder);
	} finally {
		await rm(folder, { recursive: true, force: true });
	}
}

export async function databaseAtMigration(index: number, open = () => new Database(":memory:")): Promise<Database> {
	const database = open();
	try {
		await migrateThrough(database, index);
		return database;
	} catch (error) {
		database.close();
		throw error;
	}
}
