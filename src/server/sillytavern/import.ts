// SillyTavern chat import orchestration: reads one JSONL export file as
// explicit UTF-8, maps it through the SillyTavern adapter, detects prior
// imports of the same source, preserves an independent exact-byte copy of
// the selected source in managed artifact storage, and creates the Chat
// through the generic Conversation creation seam in a single transaction.
//
// This source-specific importer prepares decoded Conversation data and the
// exact artifact, then delegates database creation to the shared Chat Import
// workflow. It never writes domain tables directly. The exact source bytes
// are copied into a unique managed relative path before the database
// operation begins; failure to store them aborts before any Chat,
// Participant, Message, Variant, Roster, Author Stamp, or artifact metadata
// row exists. The adapter resolves source authors into native Participants,
// stamps every Message, and assigns deterministic Control; zero- and
// one-Participant sources commit as incomplete Conversations whose
// playability derives once the missing seat is filled.

import { readFileSync } from "node:fs";
import { basename, parse } from "node:path";
import type { Database } from "bun:sqlite";
import {
	mediaTypeFromFilename,
	sha256Hex,
	storeExactArtifactCopy,
} from "../artifact";
import type { ArtifactMetadata } from "../artifact";
import type { ConversationSnapshot } from "../conversation/types";
import { createImportedConversation } from "../workflows";
import {
	EXACT_SOURCE_ARTIFACT_KEY,
	EXACT_SOURCE_ARTIFACT_NAMESPACE,
	decodeSillyTavernSourceBytes,
	importReportEntries,
	parseSillyTavernChatJsonl,
	type SillyTavernImportReport,
	type SillyTavernImportSource,
} from "./adapter";
import { SillyTavernImportError } from "./errors";
import { findPriorImportsBySource } from "./prior-imports";

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

const decodeUtf8 = decodeSillyTavernSourceBytes;

// The developer import path treats every prior match the same: one warning
// per prior Chat and every id listed as a duplicate. The classification
// helper feeds this merged view; the staged preview reads the same helper
// to separate exact duplicates from related sources.
const findPriorImports = (
	database: Database,
	source: SillyTavernImportSource,
): { id: number; name: string }[] =>
	findPriorImportsBySource(database, source).map(({ id, name }) => ({ id, name }));

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

	const conversation = createImportedConversation(database, {
		...parsed.input,
		participants: parsed.input.participants ?? [],
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
