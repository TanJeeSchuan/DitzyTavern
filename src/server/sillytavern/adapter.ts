// ==[HUMAN APPROVED]== SillyTavern JSONL chat adapter.
//
// Maps a SillyTavern chat export (one JSON object per line) into the generic
// Conversation creation input. This module is the only place SillyTavern
// vocabulary may appear; the Conversation module never sees it.
//
// The adapter decodes and validates: records, header, per-record structural
// defects, UTF-8 strictness, Swipe selection, and timestamps. Every later
// record becomes one native Message with one native Variant per source Swipe
// in source order (selecting exactly `swipe_id`), and a payload-only record
// becomes one selected Variant derived from its row payload. The complete
// parsed source stays value-lossless in the canonical archive.
//
// Author identity is the Import Projection's concern, not the decoder's:
// the decoded source carries the per-record exact raw captured author value
// (never trimmed or normalized) plus the parallel Message list, and the
// shared projection maps them onto native Participants under the resolution
// supplied by the import path — the Default Import Policy for the developer
// import, the user-confirmed Resolved Participant Plan for the Staged
// Import. `is_user`, header roles, a captured `Writer` name, and other
// legacy role hints never influence Participant identity or Control. Every
// imported Message receives a native immutable Author Stamp for its
// resolved Participant; no historical Control pair is ever fabricated.
import type { ConversationDataEntry } from "../conversation/types";
import { SillyTavernImportError } from "./errors";
import {
	defaultImportResolution,
	projectImport,
} from "./import-projection";
import {
	ARCHIVE_KEY,
	ARCHIVE_NAMESPACE,
	IMPORTER_VERSION,
	type ParsedSillyTavernChat,
	type SillyTavernChatInspection,
	type SillyTavernDecodedImportSource,
	type SillyTavernImportMeta,
	type SillyTavernImportReport,
	type SillyTavernImportSource,
} from "./adapter/types";
import {
	decodeHeader,
	decodeMessages,
	decodeRecords,
	sourceIntegrity,
} from "./adapter/messages";

export * from "./adapter/types";
export { decodeSillyTavernSourceBytes } from "./adapter/messages";

// ==[HUMAN APPROVED]== One adapter-owned codec constructs source identity everywhere the
// import domain needs it. Empty or absent advisory integrity is omitted so
// the decoded report, persisted report, and duplicate-index lookup share one
// representation.
export const toSillyTavernImportSource = (input: {
	filename: string;
	sha256: string;
	integrity?: string | null | undefined;
}): SillyTavernImportSource => {
	const source: SillyTavernImportSource = {
		filename: input.filename,
		sha256: input.sha256,
	};
	if (
		input.integrity !== undefined &&
		input.integrity !== null &&
		input.integrity !== ""
	) {
		source.integrity = input.integrity;
	}
	return source;
};

// ==[HUMAN APPROVED]== One decoder defines whether persisted canonical import provenance is
// readable. Import Details and duplicate classification share it so corrupt
// report JSON cannot remain usable through a stale flat query index.
export const decodeSillyTavernImportReport = (
	value: string,
): SillyTavernImportReport | null => {
	let parsed: JsonValue;
	try {
		// ==[HUMAN APPROVED]== SAFETY: JSON.parse output is confined to the JSON value domain;
		// the field checks below validate the complete report before returning it.
		parsed = JSON.parse(value) as JsonValue;
	} catch {
		return null;
	}
	if (!isJsonObject(parsed)) return null;
	const source = isJsonObject(parsed.source) ? parsed.source : null;
	const counts = isJsonObject(parsed.counts) ? parsed.counts : null;
	const integrity = source?.integrity;
	if (
		!isJsonString(parsed.importerVersion) ||
		source === null ||
		!isJsonString(source.filename) ||
		!isJsonString(source.sha256) ||
		(integrity !== undefined && !isJsonString(integrity)) ||
		counts === null ||
		!isJsonInteger(counts.messages) ||
		!isJsonInteger(counts.variants) ||
		!Array.isArray(parsed.warnings) ||
		!parsed.warnings.every(isJsonString)
	) {
		return null;
	}
	return {
		importerVersion: parsed.importerVersion,
		source: toSillyTavernImportSource({
			filename: source.filename,
			sha256: source.sha256,
			integrity,
		}),
		counts: {
			messages: counts.messages,
			variants: counts.variants,
		},
		warnings: [...parsed.warnings],
	};
};

type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

const isJsonObject = (value: JsonValue): value is JsonObject =>
	value !== null && !Array.isArray(value) && value.constructor === Object;

const isJsonString = (value: JsonValue): value is string =>
	value !== null && value.constructor === String;

const isJsonInteger = (value: JsonValue): value is number =>
	value !== null && value.constructor === Number && Number.isInteger(value);

// ==[HUMAN APPROVED]== The sealed single-pass source decode shared by the developer import path
// and the Staged Import: identical validation, counts, archive, and report,
// plus the per-record exact author values the import groups on. Previewing
// and committing re-decode the exact same staged bytes, so the review can
// never describe one file while another is committed.
export function decodeSillyTavernImportSource(
	sourceText: string,
	meta: SillyTavernImportMeta,
): SillyTavernDecodedImportSource {
	const records = decodeRecords(sourceText);
	const [headerRecord, ...messageRecords] = records;
	if (headerRecord === undefined) {
		throw new SillyTavernImportError("The source contains no records.");
	}
	const header = decodeHeader(headerRecord);
	const integrity = sourceIntegrity(header);
	const { messages, warnings, authors } = decodeMessages(messageRecords);
	const variantCount = messages.reduce(
		(total, message) => total + message.variants.length,
		0,
	);

	// ==[HUMAN APPROVED]== The canonical archive keeps the parsed header and the complete parsed
	// source message objects, so no source value is destroyed even though the
	// native projection models only a subset of it.
	const archive: ConversationDataEntry = {
		namespace: ARCHIVE_NAMESPACE,
		key: ARCHIVE_KEY,
		value: JSON.stringify({ header, messages: messageRecords }),
	};

	// ==[HUMAN APPROVED]== The Import Projection is the only writer of the flat query index;
	// this decoder contributes only the canonical archive and report value.
	const data: ConversationDataEntry[] = [archive];
	const source = toSillyTavernImportSource({
		filename: meta.filename,
		sha256: meta.sha256,
		integrity,
	});

	const report: SillyTavernImportReport = {
		importerVersion: IMPORTER_VERSION,
		source,
		counts: { messages: messages.length, variants: variantCount },
		warnings,
	};

	return { messages, authors, data, report };
}

// ==[HUMAN APPROVED]== The sealed adapter parse surface: decode plus the Default Import Policy
// through the shared Import Projection, with no prior-import evidence (the
// developer import composes duplicate evidence before projecting; this
// convenience wrapper stays for adapter-level tests and simple callers).
export function parseSillyTavernChatJsonl(
	sourceText: string,
	meta: SillyTavernImportMeta,
): ParsedSillyTavernChat {
	const decoded = decodeSillyTavernImportSource(sourceText, meta);
	const projected = projectImport(
		decoded,
		defaultImportResolution(decoded),
		{ exact: [], related: [] },
	);
	return {
		input: {
			name: meta.name,
			...projected.input,
		},
		report: projected.report,
	};
}

// ==[HUMAN APPROVED]== Preview-oriented inspection: the full structural validation of the import
// path (UTF-8 strictness, JSON line errors, header shape, per-record
// structural defects) plus the exact author values preview groups on. No
// Participant, Message, or native record is created.
export function inspectSillyTavernChatJsonl(
	sourceText: string,
	meta: SillyTavernImportMeta,
): SillyTavernChatInspection {
	const decoded = decodeSillyTavernImportSource(sourceText, meta);
	return { report: decoded.report, authors: decoded.authors };
}
