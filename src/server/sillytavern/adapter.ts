// SillyTavern JSONL chat adapter.
//
// Maps a SillyTavern chat export (one JSON object per line) into the generic
// Conversation creation input. This module is the only place SillyTavern
// vocabulary may appear; the Conversation module never sees it.
//
// Ticket 09 scope: every later record becomes one native Message, and exact
// resolved source-author groups become named Participants. Resolution trims
// the captured author name (case and Unicode preserved); a blank or
// whitespace-only name resolves to one shared Participant with a deterministic
// nonblank native name while the exact raw source value — including the empty
// string — stays untouched in the preserved import data (the message-level
// `author.name` entry and the canonical archive). `is_user`, header roles, a
// captured `Writer` name, and other legacy role hints never influence
// Participant identity or Control. Every imported Message receives a native
// immutable Author Stamp for its resolved Participant; no historical Control
// pair is ever fabricated. Current Control is assigned deterministically by
// first resolved Participant appearance: the first becomes human, the second
// model, and later Participants stay unseated; an import resolving exactly one
// Participant reserves only the human seat (incomplete), and zero Participants
// commit with no Control at all.
//
// A record carrying Swipes produces one native Variant per Swipe in source
// order, selecting exactly `swipe_id`, and derives its content, timestamps,
// and promoted generation provenance exclusively from `swipes` and the
// corresponding `swipe_info` entry — the duplicated top-level assistant
// payload is never promoted. A payload-only record becomes one selected
// Variant derived from its row payload with applicable row-level provenance
// attached. The complete parsed source stays value-lossless in the canonical
// archive.
import type {
	ConversationControlSeed,
	ConversationCreationMessage,
	ConversationDataEntry,
	ConversationParticipantSeed,
	ParticipantDefinitionPrompt,
} from "../conversation/types";
import { SillyTavernImportError } from "./errors";
import {
	ARCHIVE_KEY,
	ARCHIVE_NAMESPACE,
	IMPORTER_VERSION,
	IMPORT_KEYS,
	IMPORT_NAMESPACE,
	RESOLVED_BLANK_AUTHOR_NAME,
	type ParsedSillyTavernChat,
	type SillyTavernChatInspection,
	type SillyTavernDecodedImportSource,
	type SillyTavernExactAuthor,
	type SillyTavernImportMeta,
	type SillyTavernImportReport,
	type SillyTavernImportSource,
} from "./adapter/types";
import {
	decodeHeader,
	decodeMessages,
	decodeRecords,
	sourceIntegrity,
	type DecodedMessagesResult,
} from "./adapter/messages";

export * from "./adapter/types";
export { decodeSillyTavernSourceBytes } from "./adapter/messages";

// Imported Participants start with an empty typed Prompt and no openings:
// the history itself is the preserved record, and no identity content is
// fabricated. Names follow the shared Definition rules (leading and trailing
// whitespace removed, case and Unicode preserved).
export const emptyImportedPrompt = (): ParticipantDefinitionPrompt => ({
	systemInstruction: "",
	identity: "",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
});

// The exact resolved source-author group key: the trimmed captured author
// name, or null for the single blank/whitespace-only group. Grouping by the
// resolved value — never by `is_user`, header roles, or the literal `Writer`
// name — gives one Participant per exact resolved source-author group in
// first-appearance order.
const authorGroupKey = (rawName: string): string | null => {
	const trimmed = rawName.trim();
	return trimmed === "" ? null : trimmed;
};

// Deterministic import Control from the resolved groups: the first resolved
// Participant becomes human, the second model, and later Participants stay
// unseated. A one-Participant import reserves only the human seat so that
// adding the missing Participant later preserves it and fills the model seat;
// zero Participants commit with no Control (both seats stay incomplete).
export const deterministicImportControl = (
	groupCount: number,
): ConversationControlSeed | undefined => {
	if (groupCount === 0) return undefined;
	if (groupCount === 1) return { human: 0 };
	return { human: 0, model: 1 };
};

// The developer-import author resolution outcome: resolved Participants in
// first-appearance order, deterministic Control, and Messages stamped with
// their resolved seed index.
interface DeveloperAuthorGroups {
	participants: ConversationParticipantSeed[];
	control: ConversationControlSeed | undefined;
	messages: ConversationCreationMessage[];
}

// Developer-import author resolution: one Participant per trimmed resolved
// author group in first-appearance order, deterministic Control, and the
// exact same Message-to-group mapping the older developer command committed.
// The staged resolver never uses this function; it maps Messages onto the
// user-confirmed Participant plan instead.
const resolveDeveloperAuthorGroups = (
	decoded: Pick<DecodedMessagesResult, "messages" | "authors">,
): DeveloperAuthorGroups => {
	// Resolve author groups by first resolved appearance. Exact duplicates
	// collapse into one Participant; raw values that trim to the same name
	// (and all blanks) share a group while remaining distinct from other
	// groups whose names merely look alike after any other transformation.
	const groupIndexOf = new Map<string | null, number>();
	const groups: (string | null)[] = [];
	for (const author of decoded.authors) {
		const key = authorGroupKey(author.name);
		if (!groupIndexOf.has(key)) {
			groupIndexOf.set(key, groups.length);
			groups.push(key);
		}
	}

	const participants: ConversationParticipantSeed[] = groups.map((group) => ({
		definition: {
			name: group ?? RESOLVED_BLANK_AUTHOR_NAME,
			prompt: emptyImportedPrompt(),
			openings: [],
		},
	}));

	const messages = decoded.messages.map((message, index) => {
		// SAFETY: authors is the parallel per-record projection of messages,
		// so the author row for this Message always exists.
		const author = decoded.authors[index] as SillyTavernExactAuthor;
		// SAFETY: every decoded Message has a captured author name, so its
		// group (and thus the Participant index) always exists.
		const authorParticipantIndex = groupIndexOf.get(
			authorGroupKey(author.name),
		) as number;
		return { ...message, authorParticipantIndex };
	});

	return {
		participants,
		control: deterministicImportControl(participants.length),
		messages,
	};
};

// Complete single-pass source decode shared by the developer import path,
// the staged preview, and the staged commit: identical validation, counts,
// archive, and report, plus the per-record exact author values the resolver
// groups on. Previewing and committing re-decode the exact same staged bytes,
// so the review can never describe one file while another is committed.
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

export function parseSillyTavernChatJsonl(
	sourceText: string,
	meta: SillyTavernImportMeta,
): ParsedSillyTavernChat {
	const decoded = decodeSillyTavernImportSource(sourceText, meta);
	const { participants, control, messages } =
		resolveDeveloperAuthorGroups(decoded);
	return {
		input: {
			name: meta.name,
			participants,
			control,
			messages,
			data: decoded.data,
		},
		report: decoded.report,
	};
}

// Preview-oriented inspection: the full structural validation of the import
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
