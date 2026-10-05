import type { Database } from "bun:sqlite";
import { eq, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { imageTable } from "../database/schema";
import { imageHashes, jsonImageHashes } from "../../shared/image-reference";
import type { ImageLookup } from "../prompt-compiler";
import type { GenerationJsonValue } from "../../shared/generation-json";
import { MACRO_DATA_NAMESPACE } from "../prompt-macros";
import { ingestImage } from "./ingest";

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
	const mark = (hashes: readonly string[]) => hashes.forEach((hash) => referenced.add(hash));
	const textColumns = [
		["message_variant", ["content"]],
		["character_prompt", ["system_instruction", "identity", "scenario", "example_dialogue", "post_history_instruction"]],
		["participant_prompt", ["system_instruction", "identity", "scenario", "example_dialogue", "post_history_instruction"]],
		["character_opening", ["content"]],
		["participant_opening", ["content"]],
		["active_generation", ["checkpoint_content", "checkpoint_reasoning", "provenance_value"]],
	] as const;
	for (const [table, columns] of textColumns) {
		for (const column of columns) {
			for (const { value } of database.query<{ value: string }, []>(`SELECT ${column} AS value FROM ${table} WHERE ${column} LIKE '%](image:%'`).all()) mark(imageHashes(value));
		}
	}
	for (const table of ["character_prompt", "participant_prompt"]) {
		for (const { hash } of database.query<{ hash: string }, []>(`SELECT portrait_hash AS hash FROM ${table} WHERE portrait_hash IS NOT NULL`).all()) referenced.add(hash);
	}
	for (const table of ["message_variant_data", "conversation_data"]) {
		for (const { value } of database.query<{ value: string }, [string]>(`SELECT value FROM ${table} WHERE namespace = ? AND value LIKE '%](image:%'`).all(MACRO_DATA_NAMESPACE)) {
			const parsed: GenerationJsonValue = JSON.parse(value);
			mark(jsonImageHashes(parsed));
		}
	}
	for (const column of ["prompt_plan_json", "prompt_context_json", "prompt_inspection_json", "macro_writes_json", "generation_settings_json", "generation_intent_json", "lore_activation_json", "memory_activation_json", "connection_json"]) {
		for (const { value } of database.query<{ value: string }, []>(`SELECT ${column} AS value FROM active_generation WHERE ${column} LIKE '%](image:%'`).all()) {
			const parsed: GenerationJsonValue = JSON.parse(value);
			mark(jsonImageHashes(parsed));
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
export const imageLookup = (database: Database): ImageLookup => (hash) =>
	drizzle(database).select({ width: imageTable.width, height: imageTable.height }).from(imageTable).where(eq(imageTable.hash, hash)).get();
export const imageLoader = (database: Database) => (hash: string) => {
	const row = readImage(drizzle(database), hash);
	return row === undefined ? undefined : { bytes: row.bytes, mediaType: row.media_type };
};
