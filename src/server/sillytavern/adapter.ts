// SillyTavern JSONL chat adapter.
//
// Maps a SillyTavern chat export (one JSON object per line) into the generic
// Conversation creation input. This module is the only place SillyTavern
// vocabulary may appear; the Conversation module never sees it.
//
// Ticket 02 scope: the first nonempty record is the chat header, every later
// payload-only record becomes one native Message owning exactly one selected
// Variant derived from its row payload. Records carrying Swipes are preserved
// value-losslessly in the canonical archive but their alternative projection
// lands in a later ticket.

import type {
	ConversationCreationInput,
	ConversationCreationMessage,
	ConversationDataEntry,
} from "../conversation/types";
import { SillyTavernImportError } from "./errors";

export const IMPORTER_VERSION = "0.1.0";
export const IMPORT_NAMESPACE = "import.sillytavern";
export const ARCHIVE_NAMESPACE = "archive";
export const ARCHIVE_KEY = "source";
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

type JsonObject = { [key: string]: JsonValue };
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

const isObject = (value: JsonValue): value is JsonObject =>
	value !== null && value !== undefined && !Array.isArray(value) && value.constructor === Object;

const isString = (value: JsonValue): value is string =>
	value !== null && value !== undefined && value.constructor === String;

const isTimestamp = (value: JsonValue): value is string =>
	isString(value) && Number.isFinite(Date.parse(value));

// Parsed JSON output can only be the JSON scalars, arrays, and plain
// objects; constructor identity is therefore a sound discriminator here.

const decodeRecords = (sourceText: string): JsonValue[] => {
	const records: JsonValue[] = [];
	sourceText.split("\n").forEach((line, index) => {
		const text = line.trim();
		if (text === "") return;
		try {
			records.push(JSON.parse(text));
		} catch {
			throw new SillyTavernImportError(`Line ${index + 1} is not valid JSON.`);
		}
	});
	return records;
};

const decodeHeader = (record: JsonValue): JsonObject => {
	if (!isObject(record)) {
		throw new SillyTavernImportError(
			"The first record is not an object; expected a SillyTavern chat header.",
		);
	}
	return record;
};

const sourceIntegrity = (header: JsonObject): string | undefined => {
	const metadata = header.chat_metadata;
	if (!isObject(metadata)) return undefined;
	const integrity = metadata.integrity;
	return isString(integrity) && integrity !== "" ? integrity : undefined;
};

interface DecodedMessageRecord {
	content: string;
	sendDate: string;
	authorName: string;
}

const decodeMessageRecord = (
	record: JsonValue,
	position: number,
): DecodedMessageRecord => {
	if (!isObject(record)) {
		throw new SillyTavernImportError(
			`Record at position ${position} is not an object.`,
		);
	}
	const content = record.mes;
	if (!isString(content)) {
		throw new SillyTavernImportError(
			`Message at position ${position} has no string content ("mes").`,
		);
	}
	const sendDate = record.send_date;
	if (!isTimestamp(sendDate)) {
		throw new SillyTavernImportError(
			`Message at position ${position} has an invalid send_date.`,
		);
	}
	const authorName = record.name;
	if (!isString(authorName)) {
		throw new SillyTavernImportError(
			`Message at position ${position} has no captured author name ("name").`,
		);
	}
	return { content, sendDate, authorName };
};

const authorEntry = (
	name: string,
): ConversationDataEntry => ({
	namespace: IMPORT_NAMESPACE,
	key: IMPORT_KEYS.authorName,
	value: name,
});

interface BuildMessagesResult {
	messages: ConversationCreationMessage[];
	warnings: string[];
}

const buildMessages = (messageRecords: JsonValue[]): BuildMessagesResult => {
	const messages: ConversationCreationMessage[] = [];
	const warnings: string[] = [];
	messageRecords.forEach((record, index) => {
		const position = index + 1;
		const decoded = decodeMessageRecord(record, position);
		if (decoded.authorName === "") {
			warnings.push(
				`Message at position ${position} has a blank captured author name.`,
			);
		}
		// A payload-only record becomes one Message owning one selected
		// Variant; the source timestamp is both the Message time and the
		// Variant time. No user, assistant, or system role is derived.
		messages.push({
			timestamp: decoded.sendDate,
			data: [authorEntry(decoded.authorName)],
			variants: [
				{
					content: decoded.content,
					timestamp: decoded.sendDate,
					selected: true,
				},
			],
		});
	});
	return { messages, warnings };
};

export function parseSillyTavernChatJsonl(
	sourceText: string,
	meta: SillyTavernImportMeta,
): ParsedSillyTavernChat {
	const records = decodeRecords(sourceText);
	const [headerRecord, ...messageRecords] = records;
	if (headerRecord === undefined) {
		throw new SillyTavernImportError("The source contains no records.");
	}
	const header = decodeHeader(headerRecord);
	const integrity = sourceIntegrity(header);
	const { messages, warnings } = buildMessages(messageRecords);

	// The canonical archive keeps the parsed header and the complete parsed
	// source message objects, so no source value is destroyed even though the
	// native projection models only a subset of it.
	const archive: ConversationDataEntry = {
		namespace: ARCHIVE_NAMESPACE,
		key: ARCHIVE_KEY,
		value: JSON.stringify({ header, messages: messageRecords }),
	};

	// Source identity, counts, and importer version live in the transitional
	// import namespace; the warnings and full JSON report entries are appended
	// by the import orchestration once it knows about prior imports.
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
			value: String(messages.length),
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
		counts: { messages: messages.length, variants: messages.length },
		warnings,
	};

	return {
		input: { name: meta.name, messages, data },
		report,
	};
}

// Conversation-scoped entries derived from the final report. They are built
// after duplicate detection so the persisted warnings and report match the
// conversation they are stored with.
export const importReportEntries = (
	report: SillyTavernImportReport,
): ConversationDataEntry[] => [
	{
		namespace: IMPORT_NAMESPACE,
		key: IMPORT_KEYS.warnings,
		value: JSON.stringify(report.warnings),
	},
	{
		namespace: IMPORT_NAMESPACE,
		key: IMPORT_KEYS.reportJson,
		value: JSON.stringify(report),
	},
];