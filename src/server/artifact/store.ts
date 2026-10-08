// @approved
//  Managed filesystem operations for Conversation artifacts. The artifact
// module never deduplicates, content-addresses, reference-counts, or deletes
// physical copies; each stored copy is independent and committed files are
// never removed by any code path (unused files from later database failure
// are accepted as an intentional lifecycle tradeoff).

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import { ArtifactStoreError } from "./errors";

export interface StoredArtifactCopy {
	relativePath: string;
	byteLength: number;
	sha256: string;
}

// @approved
//  The deployment-wide managed artifact directory, mirroring the default
// SQLite path convention under the working directory.
export const defaultArtifactDirectory = (): string =>
	join(process.cwd(), "data", "artifacts");

// @approved
//  A unique managed relative path for one independent copy, keeping the leaf
// extension of the original filename for debuggability. The identity is a
// fresh UUID per copy, so two imports with identical bytes still occupy
// distinct paths (no content addressing or sharing).
export const uniqueManagedRelativePath = (originalFilename: string): string =>
	`${randomUUID()}${allowedLeafExtension(originalFilename)}`;

const allowedLeafExtension = (filename: string): string => {
	const extension = extname(basename(filename)).toLowerCase();
	// @approved
	//  Guard the stored path leaf against control characters and separators
	// that could escape the managed directory; the extension is decorative.
	return /^[a-z0-9]{1,10}$/.test(extension.slice(1)) ? extension : "";
};

// @approved
//  Derives the artifact media type from the original leaf filename. Generic
// callers may supply any media type; this is the importer's default.
export const mediaTypeFromFilename = (filename: string): string => {
	const extension = extname(basename(filename)).toLowerCase();
	switch (extension) {
		case ".jsonl":
			return "application/jsonl";
		case ".ndjson":
			return "application/x-ndjson";
		case ".json":
			return "application/json";
		default:
			return "application/octet-stream";
	}
};

// @approved
//  Resolves a managed relative path strictly inside the managed root so a
// metadata row can never read outside the managed directory. An escaping
// path is an infrastructure inconsistency (the artifact is unavailable),
// never silently treated as provenance loss: only absent or corrupt files
// report the cleaned-up outcome.
export const resolveManagedPath = (root: string, relativePath: string): string => {
	const base = resolve(root);
	const candidate = resolve(base, relativePath);
	if (candidate !== base && !candidate.startsWith(base + sep)) {
		throw new ArtifactStoreError(
			`Artifact relative path escapes the managed directory: ${relativePath}`,
		);
	}
	return candidate;
};

// @approved
//  The raw-byte SHA-256 authority shared by every managed copy: the exact
// stored bytes must reproduce this digest, preserving BOM, line endings,
// whitespace, escape spelling, blank lines, and trailing newline.
export const sha256Hex = (bytes: Buffer): string =>
	createHash("sha256").update(bytes).digest("hex");

// @approved
//  Copies the exact validated bytes into a unique managed relative path
// before any database creation begins. Any failure aborts the caller: no
// Conversation state of any kind has been created yet.
export const storeExactArtifactCopy = (
	root: string,
	bytes: Buffer,
	originalFilename: string,
): StoredArtifactCopy => {
	try {
		mkdirSync(root, { recursive: true });
		const relativePath = uniqueManagedRelativePath(originalFilename);
		writeFileSync(resolveManagedPath(root, relativePath), bytes);
		return {
			relativePath,
			byteLength: bytes.length,
			sha256: sha256Hex(bytes),
		};
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new ArtifactStoreError(
			`Could not store the exact artifact copy: ${detail}`,
		);
	}
};

export type StoredArtifactVerification =
	| { status: "available" }
	| { status: "cleaned-up"; reason: "missing" | "corrupt" };

// @approved
//  Verifies that the physical copy satisfies the committed metadata: the raw
// bytes must match the authoritative byte length and SHA-256. Absence and
// any mismatch are the nonfatal cleaned-up outcome.
export const verifyStoredArtifact = (
	root: string,
	relativePath: string,
	byteLength: number,
	sha256: string,
): StoredArtifactVerification => {
	const stored = readStoredArtifact(root, relativePath, byteLength, sha256);
	return stored.status === "available"
		? { status: "available" }
		: { status: "cleaned-up", reason: stored.reason };
};

export type StoredArtifactRead =
	| { status: "available"; bytes: Buffer }
	| { status: "cleaned-up"; reason: "missing" | "corrupt" };

// @approved
//  Reads and verifies the exact stored bytes. Reading the whole file keeps
// the SHA-256 authority honest at module level; transport-level streaming
// belongs to the route layer that consumes this seam.
export const readStoredArtifact = (
	root: string,
	relativePath: string,
	byteLength: number,
	sha256: string,
): StoredArtifactRead => {
	let bytes: Buffer;
	try {
		bytes = readFileSync(resolveManagedPath(root, relativePath));
	} catch (error) {
		// @approved
		//  Parsed at the I/O boundary: the missing-file codes become the
		// cleaned-up outcome; every other caught shape is an infrastructure
		// failure. The `in` check reads the `code` property only when the
		// caught value structurally carries it.
		const missing =
			error instanceof Error &&
			"code" in error &&
			(error.code === "ENOENT" || error.code === "ENOTDIR");
		if (missing) {
			return { status: "cleaned-up", reason: "missing" };
		}
		const detail = error instanceof Error ? error.message : String(error);
		throw new ArtifactStoreError(
			`Could not read the managed artifact at ${relativePath}: ${detail}`,
		);
	}
	if (bytes.length !== byteLength || sha256Hex(bytes) !== sha256) {
		return { status: "cleaned-up", reason: "corrupt" };
	}
	return { status: "available", bytes };
};

// @approved
//  Removes path separators, quotes, and control characters (including CR
// and LF) one character at a time so no character class over control codes
// is needed; the stored bytes and stored original filename are never
// modified.
const sanitizeCharacter = (character: string): string => {
	const code = character.charCodeAt(0);
	return code < 0x20 || code === 0x7f || character === '"' || character === "\\" || character === "/"
		? "_"
		: character;
};

export const sanitizeArtifactFilename = (filename: string): string =>
	basename(filename)
		.split("")
		.map(sanitizeCharacter)
		.join("");

export const attachmentDisposition = (filename: string): string =>
	`attachment; filename="${sanitizeArtifactFilename(filename)}"`;