import { readTestConversationSnapshot, createConversationWithHistory } from "../test-fixtures/conversation";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	createArtifactModule,
	ArtifactStoreError,
	type ArtifactModule,
	attachmentDisposition,
	mediaTypeFromFilename,
	uniqueManagedRelativePath,
	sanitizeArtifactFilename,
} from ".";
import type { ConversationArtifactSeed } from "../conversation";
import { InvalidConversationCreationError } from "../conversation";
import { artifactTable, conversationTable } from "../database/schema";
import { openInitializedDatabase } from "../database/database";

const sha256Hex = (bytes: Buffer) =>
	createHash("sha256").update(bytes).digest("hex");

const artifactSeed = (
	overrides: Partial<ConversationArtifactSeed> = {},
): ConversationArtifactSeed => ({
	namespace: "test.artifact",
	key: "source.exact",
	relativePath: uniqueManagedRelativePath("lantern-house.jsonl"),
	originalFilename: "lantern-house.jsonl",
	mediaType: "application/jsonl",
	byteLength: 0,
	sha256: sha256Hex(Buffer.alloc(0)),
	...overrides,
});

describe("Conversation artifacts", () => {
	let database: Database;
	let root: string;
	let module: ArtifactModule;
	let chatId: number;

	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
		root = mkdtempSync(join(tmpdir(), "ditzytavern-artifact-"));
		module = createArtifactModule(database, { directory: root });
		const created = createConversationWithHistory(database, {
			name: "Artifact Holder",
		});
		chatId = created.id;
	});

	afterEach(() => {
		database.close();
		rmSync(root, { recursive: true, force: true });
	});

	const createWithArtifact = (
		seed: ConversationArtifactSeed,
		bytes: Buffer = Buffer.alloc(seed.byteLength),
	) => {
		// The physical copy is placed at the managed relative path first,
		// exactly as the import orchestration does before creation.
		writeFileSync(join(root, seed.relativePath), bytes);
		return createConversationWithHistory(database, {
			name: "Artifact Conversation",
			artifacts: [seed],
		});
	};

	const countRows = (table: typeof conversationTable | typeof artifactTable) =>
		drizzle(database).select().from(table).all().length;

	test("commits the generic artifact record through the Conversation creation seam", () => {
		const bytes = Buffer.from("exact source bytes\n", "utf8");
		const seed = artifactSeed({
			byteLength: bytes.length,
			sha256: sha256Hex(bytes),
		});
		writeFileSync(join(root, seed.relativePath), bytes);

		const created = createConversationWithHistory(database, {
			name: "Artifact Conversation",
			artifacts: [seed],
		});

		// The metadata row exists with every generic field.
		const row = drizzle(database)
			.select()
			.from(artifactTable)
			.where(eq(artifactTable.conversation_id, created.id))
			.get();
		expect(row).toBeDefined();
		expect(row && {
			conversation_id: row.conversation_id,
			namespace: row.namespace,
			key: row.key,
			relative_path: row.relative_path,
			original_filename: row.original_filename,
			media_type: row.media_type,
			byte_length: row.byte_length,
			sha256: row.sha256,
		}).toEqual({
			conversation_id: created.id,
			namespace: "test.artifact",
			key: "source.exact",
			relative_path: seed.relativePath,
			original_filename: "lantern-house.jsonl",
			media_type: "application/jsonl",
			byte_length: bytes.length,
			sha256: seed.sha256,
		});

		// The public artifact seam reads the same record with availability.
		const inspection = module.getArtifact(created.id, "test.artifact", "source.exact");
		expect(inspection).toEqual({
			chatId: created.id,
			namespace: "test.artifact",
			key: "source.exact",
			relativePath: seed.relativePath,
			originalFilename: "lantern-house.jsonl",
			mediaType: "application/jsonl",
			byteLength: bytes.length,
			sha256: seed.sha256,
			availability: { status: "available" },
		});
	});

	test("rejects duplicate (namespace, key) artifact identities within one creation", () => {
		const seed = artifactSeed();
		expect(() =>
			createConversationWithHistory(database, {
				name: "Duplicate Artifacts",
				artifacts: [seed, { ...seed, relativePath: uniqueManagedRelativePath("other.jsonl") }],
			}),
		).toThrow(InvalidConversationCreationError);
		// The abort is atomic: no Chat and no artifact metadata row exist.
		expect(countRows(conversationTable)).toBe(1);
		expect(countRows(artifactTable)).toBe(0);
	});

	test("allows the same artifact identity on independent Conversations", () => {
		const seed = artifactSeed();
		const first = createWithArtifact(seed);
		const second = createWithArtifact({
			...seed,
			relativePath: uniqueManagedRelativePath("second.jsonl"),
		});

		// Both Conversations own their own metadata row and physical copy.
		expect(
			module.getArtifact(first.id, "test.artifact", "source.exact")?.availability,
		).toEqual({ status: "available" });
		expect(
			module.getArtifact(second.id, "test.artifact", "source.exact")?.availability,
		).toEqual({ status: "available" });
		expect(first.id).not.toBe(second.id);
	});

	test("validates artifact seeds against malformed metadata", () => {
		const cases: Partial<ConversationArtifactSeed>[] = [
			{ sha256: "not-a-sha" },
			{ byteLength: -1 },
			{ byteLength: 1.5 },
			{ relativePath: "  " },
			{ originalFilename: "" },
			{ mediaType: "" },
			{ namespace: "" },
			{ key: "" },
		];
		for (const tweak of cases) {
			expect(() =>
				createConversationWithHistory(database, {
					name: "Invalid Artifact",
					artifacts: [artifactSeed(tweak)],
				}),
			).toThrow(InvalidConversationCreationError);
		}
		expect(countRows(artifactTable)).toBe(0);
	});

	test("never places artifact content in ordinary Conversation snapshots", () => {
		const bytes = Buffer.from("opaque artifact payload", "utf8");
		const seed = artifactSeed({
			byteLength: bytes.length,
			sha256: sha256Hex(bytes),
			relativePath: "uuid-source.bin",
		});
		createWithArtifact(seed);

		const snapshot = readTestConversationSnapshot(database, chatId);
		const serialized = JSON.stringify(snapshot);
		expect(serialized).not.toContain("uuid-source.bin");
		expect(serialized).not.toContain("opaque artifact payload");
		// The record is only reachable through the artifact seam.
		expect(snapshot?.data).toEqual([]);
	});

	test("reads the exact stored bytes back through the public artifact seam", () => {
		const bytes = Buffer.from("\uFEFFline one\r\nline two\n", "utf8");
		const seed = artifactSeed({
			byteLength: bytes.length,
			sha256: sha256Hex(bytes),
		});
		writeFileSync(join(root, seed.relativePath), bytes);
		const created = createConversationWithHistory(database, {
			name: "Exact Round Trip",
			artifacts: [seed],
		});

		const read = module.readArtifact(created.id, "test.artifact", "source.exact");
		expect(read).toEqual({
			status: "available",
			artifact: {
				chatId: created.id,
				namespace: "test.artifact",
				key: "source.exact",
				relativePath: seed.relativePath,
				originalFilename: "lantern-house.jsonl",
				mediaType: "application/jsonl",
				byteLength: bytes.length,
				sha256: seed.sha256,
			},
			bytes,
		});
	});

	test("reports missing artifacts as cleaned up without throwing", () => {
		const seed = artifactSeed({
			byteLength: 5,
			sha256: sha256Hex(Buffer.from("12345")),
		});
		const owner = createWithArtifact(seed, Buffer.from("12345"));
		unlinkSync(join(root, seed.relativePath));

		expect(module.getArtifact(owner.id, "test.artifact", "source.exact")).toEqual({
			chatId: owner.id,
			namespace: "test.artifact",
			key: "source.exact",
			relativePath: seed.relativePath,
			originalFilename: "lantern-house.jsonl",
			mediaType: "application/jsonl",
			byteLength: 5,
			sha256: seed.sha256,
			availability: { status: "cleaned-up", reason: "missing" },
		});
		expect(module.readArtifact(owner.id, "test.artifact", "source.exact")).toEqual({
			status: "cleaned-up",
			artifact: {
				chatId: owner.id,
				namespace: "test.artifact",
				key: "source.exact",
				relativePath: seed.relativePath,
				originalFilename: "lantern-house.jsonl",
				mediaType: "application/jsonl",
				byteLength: 5,
				sha256: seed.sha256,
			},
			reason: "missing",
		});
		expect(module.downloadArtifact(owner.id, "test.artifact", "source.exact")).toEqual({
			status: "cleaned-up",
			artifact: expect.objectContaining({ chatId: owner.id }),
			reason: "missing",
		});
	});

	test("reports corrupt artifacts as cleaned up without throwing", () => {
		const bytes = Buffer.from("original bytes", "utf8");
		const seed = artifactSeed({
			byteLength: bytes.length,
			sha256: sha256Hex(bytes),
		});
		const owner = createWithArtifact(seed, bytes);
		// Overwrite with different bytes of a different length.
		writeFileSync(join(root, seed.relativePath), Buffer.from("tampered!"));

		expect(
			module.getArtifact(owner.id, "test.artifact", "source.exact")?.availability,
		).toEqual({ status: "cleaned-up", reason: "corrupt" });
		expect(module.readArtifact(owner.id, "test.artifact", "source.exact")).toEqual({
			status: "cleaned-up",
			artifact: expect.objectContaining({ chatId: owner.id }),
			reason: "corrupt",
		});
	});

	test("downloads the exact bytes with the stored original leaf filename and sanitized response metadata", () => {
		const bytes = Buffer.from("exact downloadable bytes", "utf8");
		const seed = artifactSeed({
			byteLength: bytes.length,
			sha256: sha256Hex(bytes),
			originalFilename: 'my "quoted"\nimport.jsonl',
		});
		writeFileSync(join(root, seed.relativePath), bytes);
		const created = createConversationWithHistory(database, {
			name: "Download Me",
			artifacts: [seed],
		});

		const download = module.downloadArtifact(created.id, "test.artifact", "source.exact");
		expect(download?.status).toBe("available");
		if (download?.status !== "available") return;
		// The stored original leaf filename is kept; only the response
		// metadata is sanitized. The bytes are never altered.
		expect(download.artifact.originalFilename).toBe('my "quoted"\nimport.jsonl');
		expect(download.contentDisposition).toBe(
			`attachment; filename="${sanitizeArtifactFilename('my "quoted"\nimport.jsonl')}"`,
		);
		expect(download.contentDisposition).toContain("my _quoted__import.jsonl");
		expect(download.contentDisposition).not.toContain("\n");
		expect(download.contentDisposition).not.toContain("\r");
		expect(download.bytes).toEqual(bytes);
	});

	test("refuses relative paths that escape the managed directory", () => {
		// A metadata row claiming an escaping path must never resolve into a
		// read outside the managed directory, with or without a file there.
		const seed = artifactSeed({ relativePath: "../escape.bin" });
		const created = createConversationWithHistory(database, {
			name: "Escaping Artifact",
			artifacts: [seed],
		});
		expect(() =>
			module.getArtifact(created.id, "test.artifact", "source.exact"),
		).toThrow(ArtifactStoreError);
		expect(() =>
			module.readArtifact(created.id, "test.artifact", "source.exact"),
		).toThrow(ArtifactStoreError);
	});

	test("derives media types from filenames and unique managed paths per copy", () => {
		expect(mediaTypeFromFilename("export.jsonl")).toBe("application/jsonl");
		expect(mediaTypeFromFilename("export.ndjson")).toBe("application/x-ndjson");
		expect(mediaTypeFromFilename("export.json")).toBe("application/json");
		expect(mediaTypeFromFilename("export.bin")).toBe("application/octet-stream");
		expect(attachmentDisposition("plain.jsonl")).toBe(
			'attachment; filename="plain.jsonl"',
		);
		// Each copy gets a fresh unique path even for identical filenames.
		expect(uniqueManagedRelativePath("same.jsonl")).not.toBe(
			uniqueManagedRelativePath("same.jsonl"),
		);
		expect(uniqueManagedRelativePath("same.jsonl").endsWith(".jsonl")).toBe(true);
	});
});
