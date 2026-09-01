// ==[HUMAN APPROVED]== Committed-import details: the deliberate detail operations for an
// imported Chat. Ordinary paginated reads never carry this data; Import
// Details loads the persisted receipt and source identity, structured
// duplicate evidence, and exact-source artifact availability on demand.
//
// The two preserved source representations stay immutable and outside this
// module's writes: the canonical parsed archive lives in Conversation-scoped
// data, and the exact original bytes live as a generic Conversation artifact
// under the managed artifact directory. A missing or corrupt exact artifact
// is reported as cleaned up (provenance loss, never Conversation
// corruption): only exact download is affected, while normal Chat reading
// and every Conversation command stay available.

import type { Database } from "bun:sqlite";
import type { ChatImportDuplicateEvidence } from "../../shared/contract/chat-import";
import {
	createArtifactModule,
	type ArtifactDownloadResult,
	type ArtifactInspection,
} from "../artifact";
import { createConversationModule } from "../conversation";
import { withDatabase } from "../database/database";
import {
	EXACT_SOURCE_ARTIFACT_KEY,
	EXACT_SOURCE_ARTIFACT_NAMESPACE,
	IMPORT_KEYS,
	IMPORT_NAMESPACE,
	type SillyTavernImportReport,
	type SillyTavernImportSource,
} from "./adapter";
import { findPriorImportsBySource } from "./prior-imports";

// ==[HUMAN APPROVED]== The complete Import Details payload for one imported Chat. Null is never
// a failure: a Chat without import provenance simply has no Import Details.
export interface ChatImportDetails {
	conversationId: number;
	title: string;
	// ==[HUMAN APPROVED]== The compact receipt persisted at commit: counts, warnings, source
	// identity, and importer version.
	receipt: {
		originalFilename: string;
		sha256: string;
		byteLength: number | null;
		integrity: string | null;
		counts: { messages: number; variants: number };
		warnings: string[];
		importerVersion: string;
	};
	// ==[HUMAN APPROVED]== Structured duplicate evidence as of this read, excluding this Chat
	// itself: matching raw-byte SHA-256 is an exact duplicate; a declared-
	// integrity-only match is a related source.
	duplicates: ChatImportDuplicateEvidence;
	// ==[HUMAN APPROVED]== The exact-source artifact inspection, including derived availability.
	// Present for every imported Chat; availability reports cleaned up with
	// the reason when the physical copy is missing or fails verification.
	artifact: ArtifactInspection | null;
}

export interface ChatImportDetailsModule {
	// ==[HUMAN APPROVED]== Reads the persisted receipt, source identity, duplicate evidence, and
	// exact-artifact availability for one imported Chat. Undefined when the
	// Chat exists but has no import provenance, and when the Chat itself is
	// missing.
	importDetails(conversationId: number): ChatImportDetails | undefined;
	// ==[HUMAN APPROVED]== Streams the exact managed bytes with the stored original leaf filename
	// through the artifact seal. Undefined when the Chat owns no exact
	// artifact; a cleaned-up result reports missing or corrupt without
	// touching normal Chat behavior.
	downloadExactSource(conversationId: number): ArtifactDownloadResult | undefined;
}

export function createChatImportDetailsModule(
	database: Database,
	artifactDirectory: string,
): ChatImportDetailsModule {	const artifacts = createArtifactModule(database, { directory: artifactDirectory });
	const conversations = createConversationModule(database);

	const parseReport = (value: string | null): SillyTavernImportReport | null => {
		if (value === null) return null;
		let parsed: JsonValue;
		try {
			// SAFETY: JSON.parse output is exactly the JSON scalars, arrays,
			// and plain objects modeled by JsonValue; the boundary mark keeps
			// the unvalidated parse inside this parsing function. ==[HUMAN APPROVED]==
			parsed = JSON.parse(value) as JsonValue;
		} catch {
			return null;
		}
		// ==[HUMAN APPROVED]== Parsed JSON output can only be the JSON scalars, arrays, and plain
		// objects; constructor identity is a sound discriminator here.
		if (!isObject(parsed)) return null;
		const report = parsed;
		const source = isObject(report.source) ? report.source : null;
		const counts = isObject(report.counts) ? report.counts : null;
		const integrity = source === null ? undefined : source.integrity;
		if (
			!isString(report.importerVersion) ||
			source === null ||
			!isString(source.filename) ||
			!isString(source.sha256) ||
			(integrity !== undefined && !isString(integrity)) ||
			counts === null ||
			!isNumber(counts.messages) ||
			!isNumber(counts.variants) ||
			!Array.isArray(report.warnings)
		) {
			return null;
		}
		// ==[HUMAN APPROVED]== SAFETY: every field the report contract requires (importerVersion,
		// source identity, counts, warnings, optional integrity) was validated
		// with constructor-identity guards above, so the narrowed parsed JSON
		// is a complete SillyTavernImportReport.
		const sourceValue: SillyTavernImportSource = {
			filename: source.filename,
			sha256: source.sha256,
		};
		if (integrity !== undefined && integrity !== null && integrity !== "") {
			sourceValue.integrity = integrity;
		}
		return {
			importerVersion: report.importerVersion,
			source: sourceValue,
			counts: {
				messages: counts.messages,
				variants: counts.variants,
			},
			warnings: arrayOfStrings(report.warnings),
		};
	};

	return {
		importDetails(conversationId) {
			const read = conversations.readConversationData(conversationId, {
				namespace: IMPORT_NAMESPACE,
				keys: [IMPORT_KEYS.reportJson],
			});
			// ==[HUMAN APPROVED]== Either the Chat is missing (read returns undefined) or the Chat
			// exists but carries no import provenance (report parse is null);
			// both mean "no Import Details".
			if (read === undefined) return undefined;
			const report = parseReport(importEntryValue(read.entries, IMPORT_KEYS.reportJson));
			if (report === null) return undefined;

			const artifact = artifacts.getArtifact(
				conversationId,
				EXACT_SOURCE_ARTIFACT_NAMESPACE,
				EXACT_SOURCE_ARTIFACT_KEY,
			) ?? null;
			// ==[HUMAN APPROVED]== Byte length comes from the committed artifact metadata (the
			// source-declared report never records a byte count).
			const byteLength = artifact?.byteLength ?? null;
			const sourceValue: SillyTavernImportSource = {
				filename: report.source.filename,
				sha256: report.source.sha256,
			};
			// ==[HUMAN APPROVED]== Declared integrity is advisory and optional; it participates in
			// duplicate classification only when the report carried it.
			if (
				report.source.integrity !== undefined &&
				report.source.integrity !== null &&
				report.source.integrity !== ""
			) {
				sourceValue.integrity = report.source.integrity;
			}
			const matches = findPriorImportsBySource(database, sourceValue);
			const duplicates: ChatImportDuplicateEvidence = {
				exact: matches.exact.filter((match) => match.id !== conversationId),
				related: matches.related.filter((match) => match.id !== conversationId),
			};

			return {
				conversationId,
				title: read.name,
				receipt: {
					originalFilename: report.source.filename,
					sha256: report.source.sha256,
					byteLength,
					integrity: report.source.integrity ?? null,
					counts: {
						messages: report.counts.messages,
						variants: report.counts.variants,
					},
					warnings: arrayOfStrings(report.warnings),
					importerVersion: report.importerVersion,
				},
				duplicates,
				artifact,
			};
		},

		downloadExactSource(conversationId) {
			return artifacts.downloadArtifact(
				conversationId,
				EXACT_SOURCE_ARTIFACT_NAMESPACE,
				EXACT_SOURCE_ARTIFACT_KEY,
			);
		},
	};
}

// ==[HUMAN APPROVED]== Runs one committed-import details operation against a request-scoped
// module instance, mirroring the staged import seam's helper so transport
// adapters stay thin.
export function withChatImportDetails<T>(
	database: Database | undefined,
	artifactDirectory: string,
	run: (details: ChatImportDetailsModule) => T,
): T {
	return withDatabase(database, (connection) =>
		run(createChatImportDetailsModule(connection, artifactDirectory)),
	);
}
// ==[HUMAN APPROVED]== One Conversation-scoped import entry by key from the read seam's entries.
// The seam may legitimately return other import keys for the Chat, so the
// lookup narrows by key and never assumes order or completeness.
const importEntryValue = (
	entries: readonly { key: string; value: string }[],
	key: string,
): string | null => {
	const entry = entries.find((candidate) => candidate.key === key);
	return entry?.value ?? null;
};

// ==[HUMAN APPROVED]== Parsed JSON output can only be the JSON scalars, arrays, and plain
// objects; constructor identity is therefore a sound discriminator here.
type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

const isObject = (value: JsonValue): value is JsonObject =>
	value !== null &&
	value !== undefined &&
	!Array.isArray(value) &&
	value.constructor === Object;

const isString = (value: JsonValue): value is string =>
	value !== null && value !== undefined && value.constructor === String;

const isNumber = (value: JsonValue): value is number =>
	value !== null && value !== undefined && value.constructor === Number;

// ==[HUMAN APPROVED]== Reduces a parsed JSON array to its string entries; non-strings are
// structural noise and never masquerade as warnings.
const arrayOfStrings = (entries: readonly JsonValue[]): string[] =>
	entries.filter(
		(entry): entry is string =>
			entry !== null &&
			entry !== undefined &&
			entry.constructor === String,
	);
