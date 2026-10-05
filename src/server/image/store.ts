import type { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { imageReferenceTable, imageTable } from "../database/schema";
import type { Portrait } from "../../shared/contract/image";
import type { PromptChannels } from "../../shared/contract/prompt-schema";
import { imageHashes, jsonImageHashes } from "../../shared/image-reference";
import type { ImageLookup } from "../prompt-compiler";
import type { IngestedImage } from "./ingest";

export type ImagePool = ReadonlyMap<string, IngestedImage>;

export type ImageReferenceKind = (typeof imageReferenceTable.kind.enumValues)[number];

type OwnerColumn =
	| "variant_id"
	| "character_id"
	| "participant_id"
	| "variant_data_id"
	| "conversation_data_id"
	| "active_generation_id";

export interface ImageOwner {
	kind: ImageReferenceKind;
	column: OwnerColumn;
	id: number;
}

type ImageDatabase = BunSQLiteDatabase<Record<string, never>>;

const ownerFilter = (owner: ImageOwner) =>
	and(
		eq(imageReferenceTable.kind, owner.kind),
		eq(imageReferenceTable[owner.column], owner.id),
	);

const syncImageReferences = (
	db: ImageDatabase,
	references: readonly { owner: ImageOwner; hashes: readonly string[] }[],
	pool: ImagePool,
): string[] => {
	const wantedHashes = new Set(references.flatMap(({ hashes }) => [...hashes]));
	const missing: string[] = [];
	for (const hash of wantedHashes) {
		const carried = pool.get(hash);
		if (carried !== undefined) {
			db.insert(imageTable)
				.values({
					hash,
					bytes: carried.bytes,
					media_type: carried.mediaType,
					byte_size: carried.bytes.byteLength,
					width: carried.width,
					height: carried.height,
				})
				.onConflictDoNothing()
				.run();
		} else if (db.select({ hash: imageTable.hash }).from(imageTable).where(eq(imageTable.hash, hash)).get() === undefined) {
			wantedHashes.delete(hash);
			missing.push(hash);
		}
	}

	const stale: number[] = [];
	for (const { owner, hashes } of references) {
		const wanted = new Set([...hashes].filter((hash) => wantedHashes.has(hash)));
		const current = db
			.select({ id: imageReferenceTable.id, hash: imageReferenceTable.image_hash })
			.from(imageReferenceTable)
			.where(ownerFilter(owner))
			.all();
		const kept = new Set<string>();
		for (const row of current) {
			if (wanted.has(row.hash) && !kept.has(row.hash)) kept.add(row.hash);
			else stale.push(row.id);
		}
		const fresh = [...wanted].filter((hash) => !kept.has(hash));
		if (fresh.length > 0) {
			db.insert(imageReferenceTable)
				.values(fresh.map((hash) => ({ image_hash: hash, kind: owner.kind, [owner.column]: owner.id })))
				.run();
		}
	}
	for (const id of stale) db.delete(imageReferenceTable).where(eq(imageReferenceTable.id, id)).run();
	return missing;
};

export const readImage = (db: ImageDatabase, hash: string) =>
	db.select().from(imageTable).where(eq(imageTable.hash, hash)).get();

export const dropImageReferences = (db: ImageDatabase, column: OwnerColumn, id: number) => {
	db.delete(imageReferenceTable).where(eq(imageReferenceTable[column], id)).run();
};

export const syncPortraitReference = (
	db: ImageDatabase,
	column: "character_id" | "participant_id",
	id: number,
	portrait: Portrait | undefined,
	pool: ImagePool,
): boolean =>
	syncImageReferences(db, [{ owner: { kind: "portrait", column, id }, hashes: portrait === undefined ? [] : [portrait.hash] }], pool).length === 0;

export const syncDefinitionReferences = (
	db: ImageDatabase,
	column: "character_id" | "participant_id",
	id: number,
	definition: { portrait?: Portrait | undefined; prompt: PromptChannels; openings: readonly string[] },
	pool: ImagePool = new Map(),
): boolean => {
	const missing = syncImageReferences(db, [
		{ owner: { kind: "portrait", column, id }, hashes: definition.portrait === undefined ? [] : [definition.portrait.hash] },
		{ owner: { kind: "prompt", column, id }, hashes: Object.values(definition.prompt).flatMap(imageHashes) },
		{ owner: { kind: "opening", column, id }, hashes: definition.openings.flatMap(imageHashes) },
	], pool);
	return definition.portrait === undefined || !missing.includes(definition.portrait.hash);
};

export const syncTextReferences = (
	db: ImageDatabase,
	owner: ImageOwner,
	texts: readonly string[],
	pool: ImagePool = new Map(),
) => {
	syncImageReferences(db, [{ owner, hashes: texts.flatMap(imageHashes) }], pool);
};

export const syncJsonReferences = (
	db: ImageDatabase,
	owner: ImageOwner,
	jsons: readonly string[],
	pool: ImagePool = new Map(),
) => {
	syncImageReferences(db, [{ owner, hashes: jsons.flatMap(jsonImageHashes) }], pool);
};

export const imageLookup = (database: Database, pool: ImagePool = new Map()): ImageLookup => (hash) => {
	const carried = pool.get(hash);
	if (carried !== undefined) return { width: carried.width, height: carried.height };
	return drizzle(database)
		.select({ width: imageTable.width, height: imageTable.height })
		.from(imageTable)
		.where(eq(imageTable.hash, hash))
		.get();
};

export const imageLoader = (database: Database) => (hash: string) => {
	const row = readImage(drizzle(database), hash);
	return row === undefined ? undefined : { bytes: row.bytes, mediaType: row.media_type };
};
