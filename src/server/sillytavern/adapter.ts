// @approved
//  SillyTavern JSONL chat adapter.
// Maps a SillyTavern chat export (one JSON object per line) into the generic
// Conversation creation input. This module is the only place SillyTavern
// vocabulary may appear; the Conversation module never sees it.
// The adapter decodes and validates: records, header, per-record structural
// defects, UTF-8 strictness, Swipe selection, and timestamps. Every later
// record becomes one native Message with one native Variant per source Swipe
// in source order (selecting exactly `swipe_id`), and a payload-only record
// becomes one selected Variant derived from its row payload. The complete
// parsed source stays value-lossless in the canonical archive.
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
import type { ConversationDataEntry } from "../conversation";
import { translateCommentsAndMacros } from "../prompt-preset/sillytavern";
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

// @approved
//  One adapter-owned codec constructs source identity everywhere the
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

// @approved
//  One decoder defines whether persisted canonical import provenance is
// readable. Import Details and duplicate classification share it so corrupt
// report JSON cannot remain usable through a stale flat query index.
export const decodeSillyTavernImportReport = (
	value: string,
): SillyTavernImportReport | null => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
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
	| { [key: string]: JsonValue | undefined };
type JsonObject = { [key: string]: JsonValue | undefined };

const isJsonObject = (value: unknown): value is JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isJsonString = (value: unknown): value is string => typeof value === "string";

const isJsonInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value);

// @approved
//  The sealed single-pass source decode shared by the developer import path
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
	const metadata = isJsonObject(header.chat_metadata) ? header.chat_metadata : null;
	const authorNote = isJsonString(metadata?.note_prompt) && metadata.note_prompt.trim() !== "" ? translateCommentsAndMacros(metadata.note_prompt) : "";
	const integrity = sourceIntegrity(header);
	const { messages, warnings, authors } = decodeMessages(messageRecords);
	if (authorNote !== "") {
		if ((metadata?.note_position !== undefined && metadata.note_position !== 1) || (metadata?.note_depth !== undefined && metadata.note_depth !== 0)) {
			const placement = [metadata?.note_position === undefined ? null : `position ${metadata.note_position}`,
				metadata?.note_depth === undefined ? null : `depth ${metadata.note_depth}`].filter((setting) => setting !== null).join(", ");
			warnings.push(`Author's Note placement (${placement}) was not kept; the default Author Note slot is after history.`);
		}
		if (metadata?.note_role !== undefined && metadata.note_role !== 0) warnings.push(`Author's Note role (${metadata.note_role}) was not kept; the default Author Note slot uses the system role.`);
		if (metadata?.note_interval !== undefined &&
			metadata.note_interval !== 1) warnings.push(
			`Author's Note interval (${metadata.note_interval}) was not kept; the Author Note applies to every Generation.`);
	}
	const variantCount = messages.reduce(
		(total, message) => total + message.variants.length,
		0,
	);

	// @approved
	//  The canonical archive keeps the parsed header and the complete parsed
	// source message objects, so no source value is destroyed even though the
	// native projection models only a subset of it.
	const archive: ConversationDataEntry = {
		namespace: ARCHIVE_NAMESPACE,
		key: ARCHIVE_KEY,
		value: JSON.stringify({ header, messages: messageRecords }),
	};

	// @approved
	//  The Import Projection is the only writer of the flat query index;
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

	return { authorNote, messages, authors, data, report };
}

// @approved
//  The sealed adapter parse surface: decode plus the Default Import Policy
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

// @approved
//  Preview-oriented inspection: the full structural validation of the import
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
