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
	IMPORT_KEYS,
	IMPORT_NAMESPACE,
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

	// ==[HUMAN APPROVED]== Source identity, counts, and importer version live in the transitional
	// import namespace; the warnings and full JSON report entries are
	// appended by the Import Projection once it knows about prior imports.
	const data: ConversationDataEntry[] = [archive];
	if (integrity !== undefined) {
		data.push({
			namespace: IMPORT_NAMESPACE,
			key: IMPORT_KEYS.integrity,
			value: integrity,
		});
	}
	data.push(
		{
			namespace: IMPORT_NAMESPACE,
			key: IMPORT_KEYS.sha256,
			value: meta.sha256,
		},
		{
			namespace: IMPORT_NAMESPACE,
			key: IMPORT_KEYS.filename,
			value: meta.filename,
		},
		{
			namespace: IMPORT_NAMESPACE,
			key: IMPORT_KEYS.importerVersion,
			value: IMPORTER_VERSION,
		},
		{
			namespace: IMPORT_NAMESPACE,
			key: IMPORT_KEYS.countsMessages,
			value: String(messages.length),
		},
		{
			namespace: IMPORT_NAMESPACE,
			key: IMPORT_KEYS.countsVariants,
			value: String(variantCount),
		},
	);

	const source: SillyTavernImportSource = {
		filename: meta.filename,
		sha256: meta.sha256,
	};
	if (integrity !== undefined) {
		source.integrity = integrity;
	}

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
