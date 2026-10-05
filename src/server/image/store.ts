import type { Database } from "bun:sqlite";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { imageReferenceTable, imageTable } from "../database/schema";
import type { Portrait } from "../../shared/contract/image";
import type { PromptChannels } from "../../shared/contract/prompt-schema";
import { imageHashes, jsonImageHashes } from "../../shared/image-reference";
import type { ImageLookup } from "../prompt-compiler";
import type { GenerationJsonValue } from "../../shared/generation-json";
import { ingestImage } from "./ingest";
import { InvalidImageError } from "./errors";

type ImageReferenceKind = (typeof imageReferenceTable.kind.enumValues)[number];
type OwnerColumn = "variant_id" | "character_id" | "participant_id" | "variant_data_id" | "conversation_data_id" | "active_generation_id";
export interface ImageOwner { kind: ImageReferenceKind; column: OwnerColumn; id: number }
type ImageDatabase = BunSQLiteDatabase<Record<string, never>>;
const ownerFilter = (owner: ImageOwner) => and(eq(imageReferenceTable.kind, owner.kind), eq(imageReferenceTable[owner.column], owner.id));

const syncImageReferences = (
	db: ImageDatabase,
	references: readonly { owner: ImageOwner; hashes: readonly string[] }[],
) => {
	const hashes = [...new Set(references.flatMap((reference) => reference.hashes))];
	const present = new Set(hashes.length === 0 ? [] : db.select({ hash: imageTable.hash }).from(imageTable).where(inArray(imageTable.hash, hashes)).all().map((row) => row.hash));
	const previousIds: number[] = [];
	for (const { owner, hashes } of references) {
		previousIds.push(...db.select({ id: imageReferenceTable.id }).from(imageReferenceTable).where(ownerFilter(owner)).all().map((row) => row.id));
		const wanted = [...new Set(hashes)].filter((hash) => present.has(hash));
		if (wanted.length > 0) db.insert(imageReferenceTable).values(wanted.map((hash) => ({ image_hash: hash, kind: owner.kind, [owner.column]: owner.id }))).run();
	}
	if (previousIds.length > 0) db.delete(imageReferenceTable).where(inArray(imageReferenceTable.id, previousIds)).run();
};

export const uploadImage = async (database: Database, bytes: Uint8Array) => {
	const image = await ingestImage(bytes);
	drizzle(database).insert(imageTable).values({
		hash: image.hash, bytes: image.bytes, media_type: image.mediaType,
		byte_size: image.bytes.byteLength, width: image.width, height: image.height, orphaned_at: Date.now(),
	}).onConflictDoUpdate({ target: imageTable.hash, set: { orphaned_at: sql`CASE WHEN ${imageTable.orphaned_at} IS NULL THEN NULL ELSE ${Date.now()} END` } }).run();
	return { hash: image.hash };
};
export const sweepOrphanedImages = (database: Database, now = Date.now()) =>
	drizzle(database).delete(imageTable).where(lt(imageTable.orphaned_at, now - 24 * 60 * 60 * 1000)).run();
export const readImage = (db: ImageDatabase, hash: string) =>
	db.select().from(imageTable).where(eq(imageTable.hash, hash)).get();
export const dropImageReferences = (db: ImageDatabase, column: OwnerColumn, id: number) => {
	db.delete(imageReferenceTable).where(eq(imageReferenceTable[column], id)).run();
};
export const syncDefinitionReferences = (
	db: ImageDatabase,
	column: "character_id" | "participant_id",
	id: number,
	parts: { portrait?: Portrait | undefined; prompt?: PromptChannels; openings?: readonly string[] },
) => {
	if (parts.portrait !== undefined && readImage(db, parts.portrait.hash) === undefined) throw new InvalidImageError("missing", "The Portrait image is missing.");
	const references: { owner: ImageOwner; hashes: readonly string[] }[] = [];
	if ("portrait" in parts) references.push({ owner: { kind: "portrait", column, id }, hashes: parts.portrait === undefined ? [] : [parts.portrait.hash] });
	if (parts.prompt !== undefined) references.push({ owner: { kind: "prompt", column, id }, hashes: Object.values(parts.prompt).flatMap(imageHashes) });
	if (parts.openings !== undefined) references.push({ owner: { kind: "opening", column, id }, hashes: parts.openings.flatMap(imageHashes) });
	syncImageReferences(db, references);
};
export const syncTextReferences = (db: ImageDatabase, owner: ImageOwner, texts: readonly string[]) => {
	syncImageReferences(db, [{ owner, hashes: texts.flatMap(imageHashes) }]);
};
export const syncJsonValueReferences = (db: ImageDatabase, owner: ImageOwner, values: readonly GenerationJsonValue[]) => {
	syncImageReferences(db, [{ owner, hashes: values.flatMap(jsonImageHashes) }]);
};
export const imageLookup = (database: Database): ImageLookup => (hash) =>
	drizzle(database).select({ width: imageTable.width, height: imageTable.height }).from(imageTable).where(eq(imageTable.hash, hash)).get();
export const imageLoader = (database: Database) => (hash: string) => {
	const row = readImage(drizzle(database), hash);
	return row === undefined ? undefined : { bytes: row.bytes, mediaType: row.media_type };
};
