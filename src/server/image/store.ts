import { and, eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { imageReferenceTable, imageTable } from "../database/schema";
import type { Portrait } from "../../shared/contract/image";
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

export const syncImageReferences = (
	db: ImageDatabase,
	owner: ImageOwner,
	hashes: Iterable<string>,
	pool: ImagePool,
): string[] => {
	const wanted = new Set(hashes);
	const missing: string[] = [];
	for (const hash of wanted) {
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
			wanted.delete(hash);
			missing.push(hash);
		}
	}

	const current = db
		.select({ id: imageReferenceTable.id, hash: imageReferenceTable.image_hash })
		.from(imageReferenceTable)
		.where(ownerFilter(owner))
		.all();
	const kept = new Set<string>();
	const stale: number[] = [];
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
	syncImageReferences(db, { kind: "portrait", column, id }, portrait === undefined ? [] : [portrait.hash], pool).length === 0;
