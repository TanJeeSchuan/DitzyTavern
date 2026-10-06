import type { Database } from "bun:sqlite";
import { eq, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { imageTable, type PortraitColumnRow } from "../database/schema";
import type { ImageLookup } from "../prompt-compiler";
import type { Portrait } from "../../shared/contract/image";
import { ingestImage } from "./ingest";
import { InvalidImageError } from "./errors";

type ImageDatabase = BunSQLiteDatabase<Record<string, never>>;

export const uploadImage = async (database: Database, bytes: Uint8Array) => {
	const image = await ingestImage(bytes);
	drizzle(database).insert(imageTable).values({
		hash: image.hash, bytes: image.bytes, media_type: image.mediaType,
		byte_size: image.bytes.byteLength, width: image.width, height: image.height, orphaned_at: Date.now(),
	}).onConflictDoUpdate({ target: imageTable.hash, set: { orphaned_at: sql`CASE WHEN ${imageTable.orphaned_at} IS NULL THEN NULL ELSE ${Date.now()} END` } }).run();
	return { hash: image.hash };
};

export const sweepOrphanedImages = (database: Database, now = Date.now()) => database.transaction(() => {
	// Every persisted TEXT value is a potential owner: References are found by
	// their `image:` scheme, and bare hash columns such as Portraits by holding
	// exactly one hash. Over-matching only keeps an Image longer.
	const referenced = new Set<string>();
	const reference = /image:([0-9a-f]{64})/g;
	const bareHash = `GLOB '${"[0-9a-f]".repeat(64)}'`;
	const textColumns = database.query<{ table: string; column: string }, []>(`
		SELECT m.name AS "table", c.name AS "column" FROM sqlite_schema m, pragma_table_info(m.name) c
		WHERE m.type = 'table' AND m.name <> 'image' AND m.name NOT LIKE 'sqlite_%' AND upper(c.type) = 'TEXT'`).all();
	for (const { table, column } of textColumns) {
		for (const { value } of database.query<{ value: string }, []>(`SELECT "${column}" AS value FROM "${table}" WHERE "${column}" LIKE '%image:%' OR "${column}" ${bareHash}`).all()) {
			if (value.length === 64) referenced.add(value);
			else for (const match of value.matchAll(reference)) referenced.add(match[1]!);
		}
	}
	const update = database.query("UPDATE image SET orphaned_at = ? WHERE hash = ?");
	for (const image of database.query<{ hash: string; orphaned_at: number | null }, []>("SELECT hash, orphaned_at FROM image").all()) {
		if (referenced.has(image.hash)) {
			if (image.orphaned_at !== null) update.run(null, image.hash);
		} else if (image.orphaned_at === null) update.run(now, image.hash);
	}
	return database.query("DELETE FROM image WHERE orphaned_at < ?").run(now - 24 * 60 * 60 * 1000);
}).immediate();

export const readImage = (db: ImageDatabase, hash: string) =>
	db.select().from(imageTable).where(eq(imageTable.hash, hash)).get();
export const portraitRow = (db: ImageDatabase, portrait: Portrait | undefined): PortraitColumnRow => {
	if (portrait !== undefined && readImage(db, portrait.hash) === undefined) throw new InvalidImageError("The Portrait image is missing.");
	return {
		portrait_hash: portrait?.hash ?? null,
		portrait_focal_x: portrait?.focalX ?? null,
		portrait_focal_y: portrait?.focalY ?? null,
	};
};
export const imageLookup = (database: Database): ImageLookup => (hash) =>
	drizzle(database).select({ width: imageTable.width, height: imageTable.height }).from(imageTable).where(eq(imageTable.hash, hash)).get();
export const imageLoader = (database: Database) => (hash: string) => {
	const row = readImage(drizzle(database), hash);
	return row === undefined ? undefined : { bytes: row.bytes, mediaType: row.media_type };
};
