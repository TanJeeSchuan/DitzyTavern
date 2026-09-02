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
import type { Static } from "@sinclair/typebox";
import {
	chatImportDetails,
	type ChatImportDuplicateEvidence,
} from "../../shared/contract/chat-import";
import {
	createArtifactModule,
	type ArtifactDownloadResult,
} from "../artifact";
import { createConversationModule } from "../conversation";
import { withDatabase } from "../database/database";
import {
	EXACT_SOURCE_ARTIFACT_KEY,
	EXACT_SOURCE_ARTIFACT_NAMESPACE,
	decodeSillyTavernImportReport,
	IMPORT_KEYS,
	IMPORT_NAMESPACE,
	toSillyTavernImportSource,
} from "./adapter";
import { findPriorImportsBySource } from "./prior-imports";

// ==[HUMAN APPROVED]== The complete Import Details payload for one imported Chat, derived
// from the canonical shared wire schema so the transport shape can never
// drift from it. Null is never a failure: a Chat without import provenance
// simply has no Import Details.
//
// The receipt is the compact record persisted at commit (counts, warnings,
// source identity, importer version). Duplicates are structured evidence as
// of this read, excluding this Chat itself: matching raw-byte SHA-256 is an
// exact duplicate, a declared-integrity-only match is a related source. The
// artifact is the exact-source artifact inspection including derived
// availability: present for every imported Chat, reporting cleaned up with
// the reason when the physical copy is missing or fails verification.
export type ChatImportDetails = Static<typeof chatImportDetails>;

export interface ChatImportDetailsModule {
	// ==[HUMAN APPROVED]== Reads the persisted receipt, source identity, duplicate evidence, and
	// exact-artifact availability for one imported Chat. An unreadable persisted
	// report is returned as an explicit state; undefined is reserved for a
	// missing Chat or a Chat with no report entry.
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

	return {
		importDetails(conversationId) {
			const read = conversations.readConversationData(conversationId, {
				namespace: IMPORT_NAMESPACE,
				keys: [IMPORT_KEYS.reportJson],
			});
			// ==[HUMAN APPROVED]== A missing report entry means the Chat has no import provenance;
			// an existing but invalid report is a distinct, visible read state.
			if (read === undefined) return undefined;
			const reportValue = importEntryValue(read.entries, IMPORT_KEYS.reportJson);
			if (reportValue === null) return undefined;
			const report = decodeSillyTavernImportReport(reportValue);
			if (report === null) {
				return {
					provenanceState: "unreadable",
					conversationId,
					title: read.name,
				};
			}

			const artifact = artifacts.getArtifact(
				conversationId,
				EXACT_SOURCE_ARTIFACT_NAMESPACE,
				EXACT_SOURCE_ARTIFACT_KEY,
			) ?? null;
			// ==[HUMAN APPROVED]== Byte length comes from the committed artifact metadata (the
			// source-declared report never records a byte count).
			const byteLength = artifact?.byteLength ?? null;
			const sourceValue = toSillyTavernImportSource({
				filename: report.source.filename,
				sha256: report.source.sha256,
				integrity: report.source.integrity,
			});
			// ==[HUMAN APPROVED]== Declared integrity is advisory and optional; it participates in
			// duplicate classification only when the report carried it.
			const matches = findPriorImportsBySource(database, sourceValue);
			const duplicates: ChatImportDuplicateEvidence = {
				exact: matches.exact.filter((match) => match.id !== conversationId),
				related: matches.related.filter((match) => match.id !== conversationId),
			};

			return {
				provenanceState: "readable",
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
					warnings: [...report.warnings],
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

