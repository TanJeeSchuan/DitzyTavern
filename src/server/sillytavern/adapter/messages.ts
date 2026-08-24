import type {
	ConversationCreationMessage,
	ConversationCreationVariant,
	ConversationDataEntry,
} from "../../conversation/types";
import { SillyTavernImportError } from "../errors";
import {
	IMPORT_KEYS,
	IMPORT_NAMESPACE,
	VARIANT_KEYS,
	type SillyTavernExactAuthor,
} from "./types";

type JsonObject = { [key: string]: JsonValue };
type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| JsonObject;

const isObject = (value: JsonValue): value is JsonObject =>
	value !== null && value !== undefined && !Array.isArray(value) && value.constructor === Object;

const isString = (value: JsonValue): value is string =>
	value !== null && value !== undefined && value.constructor === String;

const isNumber = (value: JsonValue): value is number =>
	value !== null && value !== undefined && value.constructor === Number;

const isTimestamp = (value: JsonValue): value is string =>
	isString(value) && Number.isFinite(Date.parse(value));

// Strict UTF-8 decoding of the exact source bytes. Invalid UTF-8 is a
// validation failure before any record is parsed; every byte sequence that
// is valid (BOM, CRLF, whitespace, escape spelling, blank lines, trailing
// newline) survives untouched.
export const decodeSillyTavernSourceBytes = (bytes: Buffer): string => {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new SillyTavernImportError("The source is not valid UTF-8.");
	}
};

// Parsed JSON output can only be the JSON scalars, arrays, and plain
// objects; constructor identity is therefore a sound discriminator here.

export const decodeRecords = (sourceText: string): JsonValue[] => {
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

export const decodeHeader = (record: JsonValue): JsonObject => {
	if (!isObject(record)) {
		throw new SillyTavernImportError(
			"The first record is not an object; expected a SillyTavern chat header.",
		);
	}
	return record;
};

export const sourceIntegrity = (header: JsonObject): string | undefined => {
	const metadata = header.chat_metadata;
	if (!isObject(metadata)) return undefined;
	const integrity = metadata.integrity;
	return isString(integrity) && integrity !== "" ? integrity : undefined;
};

const authorEntry = (
	name: string,
): ConversationDataEntry => ({
	namespace: IMPORT_NAMESPACE,
	key: IMPORT_KEYS.authorName,
	value: name,
});

const isScalar = (value: JsonValue): value is string | number | boolean => {
	if (value === null || value === undefined) return false;
	const constructor = value.constructor;
	return (
		constructor === String ||
		constructor === Number ||
		constructor === Boolean
	);
};

// Promotes one optional provenance value into the variant data when it is
// present and meaningful. Absent, null, and empty values are never promoted,
// so no placeholder is invented for a field the source did not record.
const promote = (
	data: ConversationDataEntry[],
	key: string,
	value: JsonValue | undefined,
) => {
	if (value === undefined || value === null || value === "") return;
	if (!isScalar(value)) return;
	data.push({ namespace: IMPORT_NAMESPACE, key, value: String(value) });
};

const requireTimestampWhenPresent = (
	value: JsonValue,
	description: string,
) => {
	if (value === undefined || value === null) return;
	if (!isTimestamp(value)) {
		throw new SillyTavernImportError(
			`${description} has an invalid timestamp.`,
		);
	}
};

interface DecodedMessage {
	authorName: string;
	variants: ConversationCreationVariant[];
}

const decodeMessage = (record: JsonValue, position: number): DecodedMessage => {
	if (!isObject(record)) {
		throw new SillyTavernImportError(
			`Record at position ${position} is not an object.`,
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
	const swipes = record.swipes;
	if (swipes === undefined) {
		return {
			authorName,
			variants: [payloadOnlyVariant(record, position, sendDate)],
		};
	}
	return {
		authorName,
		variants: variantsFromSwipes(record, position, swipes, sendDate),
	};
};

// A record without Swipes becomes one Message owning one selected Variant
// derived from its row payload; the source timestamp is both the Message time
// and the Variant time. Applicable row-level generation provenance is
// attached when present.
const payloadOnlyVariant = (
	record: JsonObject,
	position: number,
	sendDate: string,
): ConversationCreationVariant => {
	const content = record.mes;
	if (!isString(content)) {
		throw new SillyTavernImportError(
			`Message at position ${position} has no string content ("mes").`,
		);
	}
	requireTimestampWhenPresent(
		record.gen_started,
		`Message at position ${position} gen_started`,
	);
	requireTimestampWhenPresent(
		record.gen_finished,
		`Message at position ${position} gen_finished`,
	);
	const extra = isObject(record.extra) ? record.extra : undefined;
	const data: ConversationDataEntry[] = [];
	provenance(data, record.gen_started, record.gen_finished, extra);
	const variant: ConversationCreationVariant = {
		content,
		timestamp: sendDate,
		selected: true,
	};
	// Keep the creation input minimal: the data key appears only when
	// provenance was actually promoted.
	return data.length === 0 ? variant : { ...variant, data };
};

// One native Variant per source Swipe in source order, selecting exactly
// `swipe_id`. Content, timestamps, and promoted provenance come exclusively
// from `swipes` and the matching `swipe_info` entry; the duplicated top-level
// assistant payload is never promoted.
const variantsFromSwipes = (
	record: JsonObject,
	position: number,
	swipes: JsonValue,
	sendDate: string,
): ConversationCreationVariant[] => {
	if (!Array.isArray(swipes)) {
		throw new SillyTavernImportError(
			`Message at position ${position} has a swipes value that is not an array.`,
		);
	}
	const swipeInfo = record.swipe_info;
	if (!Array.isArray(swipeInfo) || swipeInfo.length !== swipes.length) {
		throw new SillyTavernImportError(
			`Message at position ${position} has swipe_info that does not match its swipes array.`,
		);
	}
	const swipeId = record.swipe_id;
	if (
		!isNumber(swipeId) ||
		!Number.isInteger(swipeId) ||
		swipeId < 0 ||
		swipeId >= swipes.length
	) {
		throw new SillyTavernImportError(
			`Message at position ${position} has an out-of-range swipe_id.`,
		);
	}

	return swipes.map((content, index) => {
		if (!isString(content)) {
			throw new SillyTavernImportError(
				`Message at position ${position} swipe ${index} is not a string.`,
			);
		}
		const info = swipeInfo[index];
		if (!isObject(info)) {
			throw new SillyTavernImportError(
				`Message at position ${position} swipe_info entry ${index} is not an object.`,
			);
		}
		requireTimestampWhenPresent(
			info.send_date,
			`Message at position ${position} swipe ${index} send_date`,
		);
		requireTimestampWhenPresent(
			info.gen_started,
			`Message at position ${position} swipe ${index} gen_started`,
		);
		requireTimestampWhenPresent(
			info.gen_finished,
			`Message at position ${position} swipe ${index} gen_finished`,
		);
		const extra = isObject(info.extra) ? info.extra : undefined;
		const data: ConversationDataEntry[] = [
			{
				namespace: IMPORT_NAMESPACE,
				key: VARIANT_KEYS.swipeIndex,
				value: String(index),
			},
		];
		provenance(data, info.gen_started, info.gen_finished, extra);
		return {
			content,
			// The alternative's own timestamp when recorded, else the row
			// send_date; both are real source values, never manufactured.
			timestamp: isString(info.send_date) ? info.send_date : sendDate,
			selected: index === swipeId,
			data,
		};
	});
};

// Promotes the agreed generation provenance set. Only fields present in the
// source are promoted: provider/API, model, generation ID, generation start
// and finish timestamps, duration, time to first token, finish outcome,
// reasoning duration and type, nonempty reasoning, and reasoning signatures.
const provenance = (
	data: ConversationDataEntry[],
	genStarted: JsonValue,
	genFinished: JsonValue,
	extra: JsonObject | undefined,
) => {
	promote(data, VARIANT_KEYS.api, extra?.api);
	promote(data, VARIANT_KEYS.model, extra?.model);
	promote(data, VARIANT_KEYS.generationId, extra?.gen_id);
	promote(data, VARIANT_KEYS.generationStarted, genStarted);
	promote(data, VARIANT_KEYS.generationFinished, genFinished);
	promote(data, VARIANT_KEYS.generationDuration, extra?.duration);
	promote(data, VARIANT_KEYS.timeToFirstToken, extra?.time_to_first_token);
	promote(data, VARIANT_KEYS.finishReason, extra?.finish_reason);
	promote(data, VARIANT_KEYS.reasoningDuration, extra?.reasoning_duration);
	promote(data, VARIANT_KEYS.reasoningType, extra?.reasoning_type);
	promote(data, VARIANT_KEYS.reasoningText, extra?.reasoning);
	promote(data, VARIANT_KEYS.reasoningSignature, extra?.reasoning_signature);
};

const chronological = (a: string, b: string) => Date.parse(a) - Date.parse(b);
export interface DecodedMessagesResult {
	messages: ConversationCreationMessage[];
	warnings: string[];
	authors: SillyTavernExactAuthor[];
}

// Decodes every retained record into one position-ordered Message with its
// exact captured author value. No Participant, group, or Control decision is
// made here: the developer-import path and the staged resolver each map the
// decoded Messages onto their own author grouping later, and every retained
// Message is always assigned to exactly one resolved Participant.
export const decodeMessages = (messageRecords: JsonValue[]): DecodedMessagesResult => {
	const decoded: { position: number; authorName: string; message: DecodedMessage }[] = [];
	const warnings: string[] = [];
	messageRecords.forEach((record, index) => {
		const position = index + 1;
		const message = decodeMessage(record, position);
		if (message.authorName === "") {
			warnings.push(
				`Message at position ${position} has a blank captured author name.`,
			);
		}
		decoded.push({ position, authorName: message.authorName, message });
	});

	const messages: ConversationCreationMessage[] = decoded.map((entry) => {
		// The Message time is the earliest timestamp among its own Variants,
		// so changing Variant selection can never change Message chronology.
		// No user, assistant, or system role is derived.
		// SAFETY: decodeMessage always returns at least one Variant (a
		// payload-only record receives one, and a record with an empty swipes
		// array aborts through the swipe_id range check), so the sorted
		// minimum is never undefined.
		const messageTime = entry.message.variants
			.map((variant) => variant.timestamp)
			.sort(chronological)[0] as string;
		return {
			timestamp: messageTime,
			// The exact raw source author value — including blank strings —
			// stays untouched here, while the native Author Stamp uses the
			// resolved Participant name chosen by the import flow.
			data: [authorEntry(entry.authorName)],
			variants: entry.message.variants,
		};
	});

	return {
		messages,
		warnings,
		// The verbatim captured value per retained record (never trimmed or
		// normalized) powers user-facing preview grouping; the trimmed
		// grouping above stays the developer-import resolution rule.
		authors: decoded.map((entry) => ({
			position: entry.position,
			name: entry.authorName,
			variantCount: entry.message.variants.length,
		})),
	};
};

