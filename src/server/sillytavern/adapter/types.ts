import type {
	ConversationCreationInput,
	ConversationCreationMessage,
	ConversationDataEntry,
} from "../../conversation/types";

export const IMPORTER_VERSION = "0.2.0";

// Deterministic nonblank native Participant name resolved for blank or
// whitespace-only raw source authors. Only the imported Participant carries
// this name; the raw blank source value stays unmodified in the archive and
// the message-level `author.name` entry.
export const RESOLVED_BLANK_AUTHOR_NAME = "Blank Author";
export const IMPORT_NAMESPACE = "import.sillytavern";
export const ARCHIVE_NAMESPACE = "archive";
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

// Variant-scoped promoted provenance lives in the same transitional import
// namespace. Only values present in the source are promoted; absent fields
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
// Preview grouping keys on these verbatim values so case and whitespace
// variants (and each blank captured name) stay initially separate.
export interface SillyTavernChatInspection {
	report: SillyTavernImportReport;
	authors: SillyTavernExactAuthor[];
}
export interface SillyTavernDecodedImportSource {
	// One native Message per retained record in source order. The exact raw
	// captured author value stays in each Message's `author.name` data entry
	// so preserved source values never depend on later merge, split, or
	// Character selection. No authorParticipantIndex is set here; every
	// import path maps Messages onto its own resolved Participants later.
	messages: ConversationCreationMessage[];
	// The verbatim captured author value per retained record (never trimmed
	// or normalized), parallel to `messages` by record position.
	authors: SillyTavernExactAuthor[];
	// Canonical archive plus source-identity entries. The orchestration
	// appends the final warnings and report entries after duplicate
	// detection, exactly like the developer import path.
	data: ConversationDataEntry[];
	report: SillyTavernImportReport;
}

