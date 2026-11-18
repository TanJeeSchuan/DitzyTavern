import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactModule, type ArtifactModule } from "../artifact";
import { processStateFor } from "../application/process-state";
import { deleteConversation } from "../conversation";
import { importChatFixture } from "../test-fixtures/chat-import";
import { openObservedDatabase, requireSnapshot } from "../test-fixtures/conversation";
import {
	ARCHIVE_KEY,
	ARCHIVE_NAMESPACE,
	EXACT_SOURCE_ARTIFACT_KEY,
	EXACT_SOURCE_ARTIFACT_NAMESPACE,
	IMPORT_KEYS,
	IMPORT_NAMESPACE,
} from "./adapter";
import {
	blankNameFixture as blankName,
	headerFixture as header,
	jsonl,
	rulershipFixture as second,
	writerFixture as first,
} from "./fixtures";
import { createChatImportModule, type ChatImportModule } from "./staged";

describe("SillyTavern import artifacts", () => {
	let database: Database;
	let directory: string;
	let artifacts: ArtifactModule;
	let module: ChatImportModule;

	beforeEach(() => {
		database = openObservedDatabase();
		directory = mkdtempSync(join(tmpdir(), "ditzytavern-import-"));
		artifacts = createArtifactModule(database, { directory });
		module = createChatImportModule(database, { artifactDirectory: directory });
	});
	afterEach(() => {
		processStateFor(database).dispose();
		database.close();
		rmSync(directory, { recursive: true, force: true });
	});

	const exactArtifact = (chatId: number) =>
		artifacts.getArtifact(chatId, EXACT_SOURCE_ARTIFACT_NAMESPACE, EXACT_SOURCE_ARTIFACT_KEY);
	const downloadArtifact = (chatId: number) =>
		artifacts.downloadArtifact(chatId, EXACT_SOURCE_ARTIFACT_NAMESPACE, EXACT_SOURCE_ARTIFACT_KEY);
	const importData = (chatId: number, namespace: string, key: string) =>
		requireSnapshot(database, chatId).data.find((entry) => entry.namespace === namespace && entry.key === key)?.value;

	test("preserves BOM, CRLF, escapes, blank lines, and trailing newlines in the exact artifact", async () => {
		const escapedHeader = JSON.stringify(header).replace(/-/g, "\\u002d");
		const variantA = `\uFEFF${escapedHeader}\r\n${JSON.stringify(first)}\r\n\r\n${JSON.stringify(second)}\r\n`;
		const variantB = jsonl([header, first, second]);

		for (const [filename, source] of [["bom-crlf.jsonl", variantA], ["clean.jsonl", variantB]] as const) {
			const { conversation } = await importChatFixture(module, source, filename);
			const bytes = Buffer.from(source, "utf8");
			expect(downloadArtifact(conversation.id)).toMatchObject({
				status: "available",
				bytes,
				artifact: {
					originalFilename: filename,
					byteLength: bytes.length,
					sha256: createHash("sha256").update(bytes).digest("hex"),
				},
			});
			expect(JSON.parse(importData(conversation.id, ARCHIVE_NAMESPACE, ARCHIVE_KEY) ?? "")).toEqual({
				header,
				messages: [first, second],
			});
		}
	});

	test("persists exact artifact metadata separately from the canonical archive and import report", async () => {
		const source = jsonl([header, first, blankName]);
		const { conversation, receipt } = await importChatFixture(module, source);
		expect(exactArtifact(conversation.id)).toEqual({
			chatId: conversation.id,
			namespace: EXACT_SOURCE_ARTIFACT_NAMESPACE,
			key: EXACT_SOURCE_ARTIFACT_KEY,
			relativePath: expect.any(String),
			originalFilename: "lantern-house.jsonl",
			mediaType: "application/jsonl",
			byteLength: Buffer.byteLength(source),
			sha256: createHash("sha256").update(source).digest("hex"),
			availability: { status: "available" },
		});
		expect(JSON.parse(importData(conversation.id, ARCHIVE_NAMESPACE, ARCHIVE_KEY) ?? "")).toEqual({
			header,
			messages: [first, blankName],
		});
		expect(JSON.parse(importData(conversation.id, IMPORT_NAMESPACE, IMPORT_KEYS.reportJson) ?? "")).toMatchObject({
			source: { filename: receipt.originalFilename, sha256: receipt.sha256 },
			counts: { messages: 2, variants: 2 },
			warnings: ["Message at position 2 has a blank captured author name."],
		});
	});

	test("stores an independent physical copy per import even for identical SHA-256", async () => {
		const source = jsonl([header, first, second]);
		const firstImport = await importChatFixture(module, source);
		const secondImport = await importChatFixture(module, source);
		const firstArtifact = exactArtifact(firstImport.conversation.id);
		const secondArtifact = exactArtifact(secondImport.conversation.id);
		if (firstArtifact === undefined || secondArtifact === undefined) throw new Error("Missing committed artifact");
		expect(secondArtifact.sha256).toBe(firstArtifact.sha256);
		expect(secondArtifact.relativePath).not.toBe(firstArtifact.relativePath);
		expect(secondArtifact.chatId).not.toBe(firstArtifact.chatId);

		const bytes = Buffer.from(source, "utf8");
		expect(readFileSync(join(directory, firstArtifact.relativePath))).toEqual(bytes);
		expect(readFileSync(join(directory, secondArtifact.relativePath))).toEqual(bytes);
	});

	test("reports when the staged upload cannot be stored", async () => {
		rmSync(directory, { recursive: true });
		await expect(importChatFixture(module, jsonl([header, first, second]))).rejects.toThrow(/Could not store the staged upload/);
	});

	test("never automatically deletes committed artifact copies when the Chat is deleted", async () => {
		const source = jsonl([header, first]);
		const { conversation } = await importChatFixture(module, source);
		const artifact = exactArtifact(conversation.id);
		if (artifact === undefined) throw new Error("Missing committed artifact");

		deleteConversation(database, conversation.id);
		expect(exactArtifact(conversation.id)).toBeUndefined();
		expect(downloadArtifact(conversation.id)).toBeUndefined();
		expect(readFileSync(join(directory, artifact.relativePath))).toEqual(Buffer.from(source, "utf8"));
	});
});
