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
	const referenced = new Set<string>();
	const reference = /image:([0-9a-f]{64})/g;
	const ownerColumns = [
		["message_variant", "content"],
		["character_prompt", "system_instruction"],
		["character_prompt", "identity"],
		["character_prompt", "scenario"],
		["character_prompt", "example_dialogue"],
		["character_prompt", "post_history_instruction"],
		["participant_prompt", "system_instruction"],
		["participant_prompt", "identity"],
		["participant_prompt", "scenario"],
		["participant_prompt", "example_dialogue"],
		["participant_prompt", "post_history_instruction"],
		["character_opening", "content"],
		["participant_opening", "content"],
		["active_generation", "checkpoint_content"],
		["active_generation", "checkpoint_reasoning"],
		["active_generation", "provenance_value"],
		["active_generation", "prompt_plan_json"],
		["active_generation", "prompt_context_json"],
		["active_generation", "prompt_inspection_json"],
		["active_generation", "macro_writes_json"],
		["active_generation", "generation_settings_json"],
		["active_generation", "generation_intent_json"],
		["active_generation", "lore_activation_json"],
		["active_generation", "memory_activation_json"],
		["active_generation", "connection_json"],
		["message_variant_data", "value"],
		["conversation_data", "value"],
	] as const;
	for (const [table, column] of ownerColumns) {
		for (const { value } of database.query<{ value: string }, []>(`SELECT ${column} AS value FROM ${table} WHERE ${column} LIKE '%image:%'`).all()) {
			for (const match of value.matchAll(reference)) referenced.add(match[1]!);
		}
	}
	for (const table of ["character_prompt", "participant_prompt"]) {
		for (const { hash } of database.query<{ hash: string }, []>(`SELECT portrait_hash AS hash FROM ${table} WHERE portrait_hash IS NOT NULL`).all()) referenced.add(hash);
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
