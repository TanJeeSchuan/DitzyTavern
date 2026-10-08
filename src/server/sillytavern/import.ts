// @approved
//  SillyTavern chat import orchestration: reads one JSONL export file as
// explicit UTF-8, decodes it through the SillyTavern adapter, classifies
// prior imports of the same source, preserves an independent exact-byte copy
// of the selected source in managed artifact storage, and creates the Chat
// through the generic Conversation creation seam in a single transaction.
// This source-specific importer prepares decoded Conversation data and the
// exact artifact, then delegates database creation to the shared Chat Import
// workflow. It never writes domain tables directly. The exact source bytes
// are copied into a unique managed relative path before the database
// operation begins; failure to store them aborts before any Chat,
// Participant, Message, Variant, Roster, Author Stamp, or artifact metadata
// row exists. The adapter decodes and the shared Import Projection maps the
// decoded source onto native Participants under the Default Import Policy
// (trimmed author grouping, empty imported Definitions), stamps every
// Message, and derives deterministic Control; zero- and one-Participant
// sources commit as incomplete Conversations whose playability derives once
// the missing seat is filled.
import { readFileSync } from "node:fs";
import { basename, parse } from "node:path";
import type { Database } from "bun:sqlite";
import {
	mediaTypeFromFilename,
	sha256Hex,
	storeExactArtifactCopy,
} from "../artifact";
import type { ArtifactMetadata } from "../artifact";
import type { ConversationSummary } from "../conversation";
import { createImportedConversation } from "../workflows";
import {
	EXACT_SOURCE_ARTIFACT_KEY,
	EXACT_SOURCE_ARTIFACT_NAMESPACE,
	decodeSillyTavernImportSource,
	decodeSillyTavernSourceBytes,
	type SillyTavernImportReport,
} from "./adapter";
import {
	defaultImportResolution,
	projectImport,
} from "./import-projection";
import { SillyTavernImportError } from "./errors";
import { findPriorImportsBySource } from "./prior-imports";

export interface SillyTavernImportResult {
	conversation: ConversationSummary;
	report: SillyTavernImportReport;
	duplicateChatIds: number[];
	// @approved
	//  Metadata of the exact preserved source copy, committed with the
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

export function importSillyTavernChat(
	database: Database,
	sourcePath: string,
	// @approved
	//  Managed artifact directory: every successful import preserves an
	// independent exact-byte copy of the source here, so the argument is
	// required and cannot be skipped.
	artifactDirectory: string,
): SillyTavernImportResult {
	const filename = basename(sourcePath);
	const name = chatNameFromFilename(filename);
	const bytes = readSourceBytes(sourcePath);
	const sha256 = sha256Hex(bytes);
	const sourceText = decodeUtf8(bytes);

	const decoded = decodeSillyTavernImportSource(sourceText, { name, filename, sha256 });
	// @approved
	//  Classified prior-import evidence feeds the projection's duplicate
	// warning composition: one warning per prior Chat, exact copies and
	// related sources alike, with only exact copies gated by the staged
	// confirmation later on that path.
	const priorMatches = findPriorImportsBySource(database, decoded.report.source);
	const duplicateChatIds = [...priorMatches.exact, ...priorMatches.related].map(
		(match) => match.id,
	);
	const projected = projectImport(
		decoded,
		defaultImportResolution(decoded),
		priorMatches,
	);

	// @approved
	//  The exact validated bytes are copied into a unique managed relative
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

	// @approved
	//  One construction of the committed artifact metadata: the seed
	// rides into the Conversation creation seam and the returned metadata
	// adds only the resolved Chat id.
	const artifactSeed = {
		namespace: EXACT_SOURCE_ARTIFACT_NAMESPACE,
		key: EXACT_SOURCE_ARTIFACT_KEY,
		relativePath: stored.relativePath,
		originalFilename: filename,
		mediaType: mediaTypeFromFilename(filename),
		byteLength: stored.byteLength,
		sha256: stored.sha256,
	};

	const conversation = createImportedConversation(database, {
		name,
		authorNote: projected.input.authorNote,
		participants: projected.input.participants,
		control: projected.input.control,
		messages: projected.input.messages,
		data: projected.input.data,
		artifacts: [artifactSeed],
	});

	const artifact: ArtifactMetadata = {
		chatId: conversation.id,
		...artifactSeed,
	};

	return {
		conversation,
		report: projected.report,
		duplicateChatIds,
		artifact,
	};
}
