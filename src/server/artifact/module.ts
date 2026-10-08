import type { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { artifactTable } from "../database/schema";
import type { ArtifactRow } from "./rows";
import {
	attachmentDisposition,
	readStoredArtifact,
	verifyStoredArtifact,
} from "./store";
import type {
	ArtifactInspection,
	ArtifactMetadata,
	ArtifactModule,
	ArtifactReadResult,
} from "./types";

export interface ArtifactModuleOptions {
	// @approved
	//  Managed artifact directory of the deployment; all stored copies live
	// under it by their committed relative paths.
	directory: string;
}

const toMetadata = (row: ArtifactRow): ArtifactMetadata => ({
	chatId: row.conversation_id,
	namespace: row.namespace,
	key: row.key,
	relativePath: row.relative_path,
	originalFilename: row.original_filename,
	mediaType: row.media_type,
	byteLength: row.byte_length,
	sha256: row.sha256,
});

export function createArtifactModule(
	database: Database,
	options: ArtifactModuleOptions,
): ArtifactModule {
	const findRow = (
		conversationId: number,
		namespace: string,
		key: string,
	): ArtifactRow | undefined =>
		drizzle(database)
			.select()
			.from(artifactTable)
			.where(
				and(
					eq(artifactTable.conversation_id, conversationId),
					eq(artifactTable.namespace, namespace),
					eq(artifactTable.key, key),
				),
			)
			.get();

	const inspectRow = (row: ArtifactRow): ArtifactInspection => ({
		...toMetadata(row),
		availability: verifyStoredArtifact(
			options.directory,
			row.relative_path,
			row.byte_length,
			row.sha256,
		),
	});

	const readRow = (row: ArtifactRow): ArtifactReadResult => {
		const metadata = toMetadata(row);
		const stored = readStoredArtifact(
			options.directory,
			row.relative_path,
			row.byte_length,
			row.sha256,
		);
		return stored.status === "available"
			? { status: "available", artifact: metadata, bytes: stored.bytes }
			: { status: "cleaned-up", artifact: metadata, reason: stored.reason };
	};

	return {
		getArtifact(conversationId, namespace, key) {
			const row = findRow(conversationId, namespace, key);
			return row === undefined ? undefined : inspectRow(row);
		},
		readArtifact(conversationId, namespace, key) {
			const row = findRow(conversationId, namespace, key);
			return row === undefined ? undefined : readRow(row);
		},
		downloadArtifact(conversationId, namespace, key) {
			const row = findRow(conversationId, namespace, key);
			if (row === undefined) return undefined;
			const read = readRow(row);
			if (read.status === "cleaned-up") return read;
			// @approved
			//  Response metadata derives from the stored original leaf
			// filename and is sanitized; the exact bytes are untouched.
			return {
				status: "available",
				artifact: read.artifact,
				bytes: read.bytes,
				contentDisposition: attachmentDisposition(read.artifact.originalFilename),
			};
		},
	};
}