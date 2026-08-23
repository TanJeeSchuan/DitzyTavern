// SillyTavern chat import orchestration: reads one JSONL export file as
// explicit UTF-8, maps it through the SillyTavern adapter, detects prior
// imports of the same source, preserves an independent exact-byte copy of
// the selected source in managed artifact storage, and creates the Chat
// through the generic Conversation creation seam in a single transaction.
//
// This orchestration is the application workflow entry point for imports: it
// composes only public seams (the adapter, the generic artifact store, and
// the deep Conversation module), never writing domain tables directly. The
// exact source bytes are copied into a unique managed relative path before
// the database creation operation begins; failure to store them aborts
// before any Chat, Participant, Message, Variant, Roster, Author Stamp, or
// artifact metadata row exists. The adapter resolves source authors into
// native Participants, stamps every Message, and assigns deterministic
// Control; zero- and one-Participant sources commit as incomplete
// Conversations whose playability derives once the missing seat is filled.

import { readFileSync } from "node:fs";
import { basename, parse } from "node:path";
import type { Database } from "bun:sqlite";
import { and, eq, inArray, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	mediaTypeFromFilename,
	sha256Hex,
	storeExactArtifactCopy,
} from "../artifact";
import type { ArtifactMetadata } from "../artifact";
import { createConversationModule } from "../conversation";
import type { ConversationSnapshot } from "../conversation/types";
import { chatDataTable, chatTable } from "../database/schema";
import {
	EXACT_SOURCE_ARTIFACT_KEY,
	EXACT_SOURCE_ARTIFACT_NAMESPACE,
	IMPORT_KEYS,
	IMPORT_NAMESPACE,
	importReportEntries,
	parseSillyTavernChatJsonl,
	type SillyTavernImportReport,
	type SillyTavernImportSource,
} from "./adapter";
import { SillyTavernImportError } from "./errors";

export interface SillyTavernImportResult {
	conversation: ConversationSnapshot;
	report: SillyTavernImportReport;
	duplicateChatIds: number[];
	// Metadata of the exact preserved source copy, committed with the
	// Conversation; the physical bytes live under the managed relative path.
	artifact: ArtifactMetadata;
}

export const chatNameFromFilename = (filename: string): string => parse(filename).name;

const readSourceBytes = (sourcePath: string): Buffer => {
	try {
		return readFileSync(sourcePath);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new SillyTavernImportError(`Could not read ${sourcePath}: ${detail}`);
	}
};

const decodeUtf8 = (bytes: Buffer): string => {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new SillyTavernImportError("The source is not valid UTF-8.");
	}
};

const findPriorImports = (
	database: Database,
	source: SillyTavernImportSource,
): { id: number; name: string }[] => {
	const conditions = [
		and(
			eq(chatDataTable.namespace, IMPORT_NAMESPACE),
			eq(chatDataTable.key, IMPORT_KEYS.sha256),
			eq(chatDataTable.value, source.sha256),
		),
	];
	if (source.integrity !== undefined) {
		conditions.push(
			and(
				eq(chatDataTable.namespace, IMPORT_NAMESPACE),
				eq(chatDataTable.key, IMPORT_KEYS.integrity),
				eq(chatDataTable.value, source.integrity),
			),
		);
	}

	const db = drizzle(database);
	const priorChatIds = [
		...new Set(
			db
				.select({ chatId: chatDataTable.chat_id })
				.from(chatDataTable)
				.where(or(...conditions))
				.all()
				.map((row) => row.chatId),
		),
	];
	if (priorChatIds.length === 0) return [];

	return db
		.select({ id: chatTable.id, name: chatTable.name })
		.from(chatTable)
		.where(inArray(chatTable.id, priorChatIds))
		.all();
};

export function importSillyTavernChat(
	database: Database,
	sourcePath: string,
	// Managed artifact directory: every successful import preserves an
	// independent exact-byte copy of the source here, so the argument is
	// required and cannot be skipped.
	artifactDirectory: string,
): SillyTavernImportResult {
	const filename = basename(sourcePath);
	const name = chatNameFromFilename(filename);
	const bytes = readSourceBytes(sourcePath);
	const sha256 = sha256Hex(bytes);
	const sourceText = decodeUtf8(bytes);

	const parsed = parseSillyTavernChatJsonl(sourceText, { name, filename, sha256 });
	const priorImports = findPriorImports(database, parsed.report.source);
	const duplicateChatIds = priorImports.map((chat) => chat.id);
	for (const prior of priorImports) {
		parsed.report.warnings.push(
			`Source was already imported as chat ${prior.id} ("${prior.name}"); this import creates an independent copy.`,
		);
	}

	// The exact validated bytes are copied into a unique managed relative
	// path before the database creation operation begins. Failure here
	// aborts with no Chat, Participant, Profile, Message, Variant, Roster,
	// Author Stamp, or artifact metadata row created. If the database
	// commit fails later, the already stored file may remain unused; no
	// cleanup or recovery subsystem is added.
	let stored: ReturnType<typeof storeExactArtifactCopy>;
	try {
		stored = storeExactArtifactCopy(artifactDirectory, bytes, filename);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new SillyTavernImportError(
			`Could not preserve the exact source artifact: ${detail}`,
		);
	}

	const conversation = createConversationModule(database).create({
		...parsed.input,
		data: [...(parsed.input.data ?? []), ...importReportEntries(parsed.report)],
		artifacts: [
			{
				namespace: EXACT_SOURCE_ARTIFACT_NAMESPACE,
				key: EXACT_SOURCE_ARTIFACT_KEY,
				relativePath: stored.relativePath,
				originalFilename: filename,
				mediaType: mediaTypeFromFilename(filename),
				byteLength: stored.byteLength,
				sha256: stored.sha256,
			},
		],
	});

	const artifact: ArtifactMetadata = {
		chatId: conversation.id,
		namespace: EXACT_SOURCE_ARTIFACT_NAMESPACE,
		key: EXACT_SOURCE_ARTIFACT_KEY,
		relativePath: stored.relativePath,
		originalFilename: filename,
		mediaType: mediaTypeFromFilename(filename),
		byteLength: stored.byteLength,
		sha256: stored.sha256,
	};

	return {
		conversation,
		report: parsed.report,
		duplicateChatIds,
		artifact,
	};
}