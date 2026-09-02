import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { and, eq } from "drizzle-orm";
import { createArtifactModule, type ArtifactModule } from "../artifact";
import { openDatabase } from "../database/database";
import { createConversationModule } from "../conversation";
import {
	artifactTable,
	conversationDataTable,
	conversationTable,
	messageTable,
	messageVariantTable,
	participantTable,
} from "../database/schema";
import {
	ARCHIVE_KEY,
	ARCHIVE_NAMESPACE,
	EXACT_SOURCE_ARTIFACT_KEY,
	EXACT_SOURCE_ARTIFACT_NAMESPACE,
	IMPORT_KEYS,
	IMPORT_NAMESPACE,
	importSillyTavernChat,
} from "./index";
import {
	blankNameFixture as blankName,
	headerFixture as header,
	jsonl,
	rulershipFixture as second,
	writerFixture as first,
} from "./fixtures";

const findEntry = (
	entries: { namespace: string; key: string; value: string }[] | undefined,
	namespace: string,
	key: string,
) => entries?.find((entry) => entry.namespace === namespace && entry.key === key);

describe("SillyTavern import artifacts", () => {
	let database: Database;
	let files: string[];
	let artifactDirectory: string;
	let artifacts: ArtifactModule;

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
		const directory = mkdtempSync(join(tmpdir(), "ditzytavern-import-"));
		files = [directory];
		artifactDirectory = join(directory, "managed-artifacts");
		artifacts = createArtifactModule(database, { directory: artifactDirectory });
	});
	afterEach(() => {
		database.close();
		for (const path of files) rmSync(path, { recursive: true, force: true });
	});

	// Every import call in these tests preserves the exact source bytes in
	// an isolated managed artifact directory, through the same public
	// signature the developer command uses.
	const importChat = (sourcePath: string) =>
		importSillyTavernChat(database, sourcePath, artifactDirectory);

	const writeSource = (records: unknown[], filename = "lantern-house.jsonl") => {
		const path = join(files[0] ?? "", filename);
		writeFileSync(path, jsonl(records), "utf8");
		return path;
	};

	// Writes raw source bytes (BOM, CRLF, escape spelling, and trailing
	// newlines included) without re-serializing through the fixture helper.
	const writeSourceRaw = (text: string, filename: string) => {
		const path = join(files[0] ?? "", filename);
		writeFileSync(path, Buffer.from(text, "utf8"));
		return path;
	};

	const countRows = (
		table:
			| typeof conversationTable
			| typeof messageTable
			| typeof messageVariantTable
			| typeof conversationDataTable
			| typeof artifactTable
			| typeof participantTable,
	) => drizzle(database).select().from(table).all().length;

	const exactArtifact = (chatId: number) =>
		artifacts.getArtifact(
			chatId,
			EXACT_SOURCE_ARTIFACT_NAMESPACE,
			EXACT_SOURCE_ARTIFACT_KEY,
		);

	test("preserves an exact-byte copy that keeps BOM, CRLF, escapes, blank lines, and trailing newlines", () => {
		// Two source texts that parse to the same canonical chat but differ
		// only in bytes: BOM prefix, CRLF line endings, \u002d escape
		// spelling for every hyphen, a blank line, and a trailing newline
		// versus the clean LF form used by every other fixture.
		const escapedHeader = JSON.stringify(header).replace(/-/g, "\\u002d");
		const variantA = `\uFEFF${escapedHeader}\r\n${JSON.stringify(first)}\r\n\r\n${JSON.stringify(second)}\r\n`;
		const variantB = jsonl([header, first, second]);

		const pathA = writeSourceRaw(variantA, "bom-crlf.jsonl");
		const pathB = writeSourceRaw(variantB, "clean.jsonl");

		const chatA = importChat(pathA).conversation;
		const chatB = importChat(pathB).conversation;

		// The source SHA is authoritative over the raw bytes: the two files
		// differ in BOM, line endings, escape spelling, blank lines, and the
		// trailing newline, yet both remain valid.
		const bytesA = Buffer.from(variantA, "utf8");
		const bytesB = Buffer.from(variantB, "utf8");
		expect(bytesA.equals(bytesB)).toBe(false);

		const shaA = createHash("sha256").update(bytesA).digest("hex");
		const shaB = createHash("sha256").update(bytesB).digest("hex");
		expect(shaA).not.toBe(shaB);

		const artifactA = exactArtifact(chatA.id);
		const artifactB = exactArtifact(chatB.id);
		expect(artifactA?.availability).toEqual({ status: "available" });
		expect(artifactA?.sha256).toBe(shaA);
		expect(artifactA?.originalFilename).toBe("bom-crlf.jsonl");
		expect(artifactA?.byteLength).toBe(bytesA.length);
		expect(artifactB?.availability).toEqual({ status: "available" });
		expect(artifactB?.sha256).toBe(shaB);

		// Exact-byte round trips through the public artifact seam: the
		// downloaded bytes equal the raw source file bytes, BOM and CRLF and
		// all, never a normalized re-serialization.
		const readA = artifacts.readArtifact(
			chatA.id,
			EXACT_SOURCE_ARTIFACT_NAMESPACE,
			EXACT_SOURCE_ARTIFACT_KEY,
		);
		const readB = artifacts.readArtifact(
			chatB.id,
			EXACT_SOURCE_ARTIFACT_NAMESPACE,
			EXACT_SOURCE_ARTIFACT_KEY,
		);
		expect(readA?.status).toBe("available");
		expect(readB?.status).toBe("available");
		if (readA?.status !== "available" || readB?.status !== "available") return;
		expect(readA.bytes).toEqual(bytesA);
		expect(readB.bytes).toEqual(bytesB);
		expect(readA.artifact.sha256).toBe(shaA);
		expect(readA.artifact.originalFilename).toBe("bom-crlf.jsonl");
		expect(readA.artifact.byteLength).toBe(bytesA.length);
		expect(readB.artifact.sha256).toBe(shaB);
		expect(readB.artifact.originalFilename).toBe("clean.jsonl");

		// Both parse to the identical canonical archive despite the byte
		// differences: the exact representation and the canonical one are
		// preserved independently.
		const archiveOf = (data: { namespace: string; key: string; value: string }[]) =>
			JSON.parse(
				findEntry(data, ARCHIVE_NAMESPACE, ARCHIVE_KEY)?.value ?? "",
			);
		expect(archiveOf(chatA.data)).toEqual({
			header,
			messages: [first, second],
		});
		expect(archiveOf(chatB.data)).toEqual({
			header,
			messages: [first, second],
		});
	});

	test("returns the exact artifact metadata with the import result and keeps the canonical archive separate", () => {
		const path = writeSource([header, first, blankName], "lantern-house.jsonl");
		const rawBytes = readFileSync(path);
		const result = importChat(path);
		const { conversation, artifact, report } = result;

		// The committed metadata carries the full generic record.
		expect(artifact).toEqual({
			chatId: conversation.id,
			namespace: EXACT_SOURCE_ARTIFACT_NAMESPACE,
			key: EXACT_SOURCE_ARTIFACT_KEY,
			relativePath: expect.any(String),
			originalFilename: "lantern-house.jsonl",
			mediaType: "application/jsonl",
			byteLength: rawBytes.length,
			sha256: report.source.sha256,
		});

		// The canonical parsed archive and compact report remain separate
		// conversation-scoped data; the exact artifact lives only in the
		// managed store behind the artifact seam.
		expect(JSON.parse(findEntry(conversation.data, ARCHIVE_NAMESPACE, ARCHIVE_KEY)?.value ?? "")).toEqual({
			header,
			messages: [first, blankName],
		});
		expect(
			JSON.parse(
				findEntry(conversation.data, IMPORT_NAMESPACE, IMPORT_KEYS.reportJson)
					?.value ?? "",
			),
		).toEqual(report);
		const inspection = exactArtifact(conversation.id);
		expect(inspection?.availability).toEqual({ status: "available" });
		expect(inspection?.byteLength).toBe(rawBytes.length);
		expect(inspection?.originalFilename).toBe("lantern-house.jsonl");
		expect(inspection?.relativePath).toBe(artifact.relativePath);

		// The archived value is a parsed re-serialization, never the exact
		// bytes: canonical and exact remain distinguishable.
		expect(
			drizzle(database)
				.select()
				.from(conversationDataTable)
				.where(
					and(
						eq(conversationDataTable.conversation_id, conversation.id),
						eq(conversationDataTable.namespace, ARCHIVE_NAMESPACE),
						eq(conversationDataTable.key, ARCHIVE_KEY),
					),
				)
				.get()?.value,
		).not.toBe(rawBytes.toString("utf8"));
	});

	test("stores an independent physical copy per import even for identical SHA-256", () => {
		const path = writeSource([header, first, second]);
		const firstChat = importChat(path);
		const secondChat = importChat(path);

		expect(secondChat.report.source.sha256).toBe(firstChat.report.source.sha256);
		expect(secondChat.artifact.relativePath).not.toBe(
			firstChat.artifact.relativePath,
		);
		expect(secondChat.artifact.chatId).not.toBe(firstChat.artifact.chatId);

		// Both physical copies exist at their own managed paths and both
		// deliver the exact same bytes; nothing is deduplicated.
		expect(
			readFileSync(join(artifactDirectory, firstChat.artifact.relativePath)),
		).toEqual(readFileSync(path));
		expect(
			readFileSync(join(artifactDirectory, secondChat.artifact.relativePath)),
		).toEqual(readFileSync(path));
		expect(exactArtifact(firstChat.conversation.id)?.availability).toEqual({
			status: "available",
		});
		expect(exactArtifact(secondChat.conversation.id)?.availability).toEqual({
			status: "available",
		});
	});

	test("aborts before creating any database rows when the exact artifact cannot be stored", () => {
		const path = writeSource([header, first, second]);
		// A regular file in place of a directory makes the managed root
		// impossible to create, forcing the initial storage failure.
		const blocker = join(files[0] ?? "", "blocker");
		writeFileSync(blocker, "not a directory");
		const brokenArtifactDirectory = join(blocker, "managed-artifacts");

		expect(() =>
			importSillyTavernChat(database, path, brokenArtifactDirectory),
		).toThrow(/preserve the exact source artifact/);

		// The abort happens before the database creation operation begins:
		// no Chat, Participant, Profile, Message, Variant, Roster, Author
		// Stamp, or artifact metadata row exists.
		expect(countRows(conversationTable)).toBe(0);
		expect(countRows(participantTable)).toBe(0);
		expect(countRows(messageTable)).toBe(0);
		expect(countRows(messageVariantTable)).toBe(0);
		expect(countRows(conversationDataTable)).toBe(0);
		expect(countRows(artifactTable)).toBe(0);
	});

	test("reports a missing or corrupt exact artifact as cleaned up while native Conversation behavior stays usable", () => {
		const path = writeSource([header, first]);
		const { conversation, artifact } = importChat(path);
		const module = createConversationModule(database);

		// Nonfatal disappearance: deleting the physical copy never throws
		// and never impairs the native Conversation.
		rmSync(join(artifactDirectory, artifact.relativePath));

		expect(exactArtifact(conversation.id)?.availability).toEqual({
			status: "cleaned-up",
			reason: "missing",
		});
		expect(
			artifacts.readArtifact(
				conversation.id,
				EXACT_SOURCE_ARTIFACT_NAMESPACE,
				EXACT_SOURCE_ARTIFACT_KEY,
			)?.status,
		).toBe("cleaned-up");

		// The native Chat and its canonical archive remain fully usable.
		const snapshot = module.getSnapshot(conversation.id);
		expect(snapshot?.id).toBe(conversation.id);
		expect(snapshot?.playable).toBe(false);
		expect(JSON.parse(findEntry(snapshot?.data ?? [], ARCHIVE_NAMESPACE, ARCHIVE_KEY)?.value ?? "")).toEqual({
			header,
			messages: [first],
		});
		expect(snapshot?.messages).toHaveLength(1);

		// Normal Conversation commands keep working after the disappearance.
		const writer = snapshot?.cast[0];
		expect(writer).toBeDefined();
		const renamed = module.execute({
			conversationId: conversation.id,
			expectedRevision: snapshot?.revision ?? 0,
			action: {
				type: "rename-participant",
				participantId: writer?.id ?? 0,
				name: "Renamed After Cleanup",
			},
		});
		expect(renamed.cast[0]?.name).toBe("Renamed After Cleanup");
		expect(renamed.revision).toBe(1);

		// A corrupt file (wrong bytes) is likewise cleaned up, not fatal.
		const corruptPath = join(artifactDirectory, artifact.relativePath);
		writeFileSync(corruptPath, Buffer.from("different bytes", "utf8"));
		expect(exactArtifact(conversation.id)?.availability).toEqual({
			status: "cleaned-up",
			reason: "corrupt",
		});
	});

	test("never automatically deletes committed artifact copies when the Chat is removed", () => {
		const path = writeSource([header, first]);
		const { conversation, artifact } = importChat(path);
		const storedPath = join(artifactDirectory, artifact.relativePath);

		// No public Chat-deletion seam exists; removing the Chat row directly
		// simulates the future deletion path. The metadata row follows the
		// Chat, but the committed physical copy is never automatically
		// deleted and no cleanup subsystem touches it.
		database.run("DELETE FROM conversation WHERE id = ?", [conversation.id]);
		expect(exactArtifact(conversation.id)).toBeUndefined();
		expect(
			artifacts.readArtifact(
				conversation.id,
				EXACT_SOURCE_ARTIFACT_NAMESPACE,
				EXACT_SOURCE_ARTIFACT_KEY,
			),
		).toBeUndefined();
		expect(readFileSync(storedPath)).toEqual(readFileSync(path));
	});

	test("downloads the exact artifact under the stored original leaf filename", () => {
		const path = writeSource([header, first], "archive-2026-08-08.jsonl");
		const { conversation } = importChat(path);
		const download = artifacts.downloadArtifact(
			conversation.id,
			EXACT_SOURCE_ARTIFACT_NAMESPACE,
			EXACT_SOURCE_ARTIFACT_KEY,
		);
		expect(download?.status).toBe("available");
		if (download?.status !== "available") return;
		expect(download.contentDisposition).toBe(
			'attachment; filename="archive-2026-08-08.jsonl"',
		);
		expect(download.bytes).toEqual(readFileSync(path));
	});
});
