import type {
	ConversationCreationInput,
	ConversationCreationMessage,
	ConversationDataEntry,
} from "../../conversation/types";

import {
	ARCHIVE_NAMESPACE,
	IMPORT_NAMESPACE,
} from "../../../shared/import-data";

export const IMPORTER_VERSION = "0.2.0";

// The import-owned data namespaces are declared once in shared/import-data —
// the Conversation data seam and the wire contract reserve them against the
// generic data commands — and the adapter re-exports them as its vocabulary.
export { ARCHIVE_NAMESPACE, IMPORT_NAMESPACE };
export const ARCHIVE_KEY = "source";
// Generic artifact identity of the exact preserved source bytes. The
// artifact metadata row commits with the Conversation while the opaque
// original bytes live in the managed artifact directory under a unique
// relative path; the canonical parsed archive above stays separate.
export const EXACT_SOURCE_ARTIFACT_NAMESPACE = IMPORT_NAMESPACE;
export const EXACT_SOURCE_ARTIFACT_KEY = "source.exact";
export const IMPORT_KEYS = {
	integrity: "source.integrity",
	sha256: "source.sha256",
	filename: "source.filename",
	importerVersion: "importer.version",
	countsMessages: "counts.messages",
	countsVariants: "counts.variants",
	authorName: "author.name",
	warnings: "warnings",
	reportJson: "report.json",
} as const;

// Variant-scoped promoted provenance lives in the same import namespace. Only
// values present in the source are promoted; absent fields
// are not manufactured as empty placeholders.
export const VARIANT_KEYS = {
	swipeIndex: "variant.swipe.index",
	api: "variant.api",
	model: "variant.model",
	generationId: "variant.generation.id",
	generationStarted: "variant.generation.started",
	generationFinished: "variant.generation.finished",
	generationDuration: "variant.generation.duration",
	timeToFirstToken: "variant.generation.timeToFirstToken",
	finishReason: "variant.generation.finishReason",
	reasoningDuration: "variant.reasoning.duration",
	reasoningType: "variant.reasoning.type",
	reasoningText: "variant.reasoning.text",
	reasoningSignature: "variant.reasoning.signature",
} as const;

export interface SillyTavernImportSource {
	filename: string;
	sha256: string;
	integrity?: string;
}

export interface SillyTavernImportReport {
	importerVersion: string;
	source: SillyTavernImportSource;
	counts: {
		messages: number;
		variants: number;
	};
	warnings: string[];
}

export interface SillyTavernImportMeta {
	name: string;
	filename: string;
	sha256: string;
}

export interface ParsedSillyTavernChat {
	input: ConversationCreationInput;
	report: SillyTavernImportReport;
}

// One retained message record's exact raw captured author value in source
// order. `position` is the 1-based record position used by every contextual
// validation message; `name` is the verbatim captured value, never trimmed
// or normalized; `variantCount` counts the record's native Variants.
export interface SillyTavernExactAuthor {
	position: number;
	name: string;
	variantCount: number;
}

// Inspection result for staged previews: the same complete source
// validation as the import path plus the per-record exact author values.
// Preview grouping keys on the resolved (trimmed) values through the shared
// Import Projection primitive; the verbatim values themselves stay available
// in preserved source data.
export interface SillyTavernChatInspection {
	report: SillyTavernImportReport;
	authors: SillyTavernExactAuthor[];
}
export interface SillyTavernDecodedImportSource {
	authorNote: string;
	// One native Message per retained record in source order. The exact raw
	// captured author value stays in each Message's `author.name` data entry
	// so preserved source values never depend on later merge, split, or
	// Character selection. No authorParticipantIndex is set here; every
	// import path maps Messages onto its own resolved Participants later.
	messages: ConversationCreationMessage[];
	// The verbatim captured author value per retained record (never trimmed
	// or normalized), parallel to `messages` by record position.
	authors: SillyTavernExactAuthor[];
	// Canonical archive entry. The Import Projection appends source identity,
	// derived query-index, warnings, and report entries after duplicate
	// evidence is known.
	data: ConversationDataEntry[];
	report: SillyTavernImportReport;
}
