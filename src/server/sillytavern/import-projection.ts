// Canonical Import Projection: the pure source-to-native derivation shared
// by the developer import and the Staged Import.
//
// The SillyTavern adapter decodes and validates the source one way; the
// projection then owns everything that maps decoded source into native
// Conversation creation data — resolved author ownership, Message stamping,
// Control derivation, archive/report entries, and duplicate warning
// composition. Each import path supplies a different resolution: the
// developer import uses the Default Import Policy (trimmed author grouping,
// empty imported Definitions), and the Staged Import supplies the
// user-confirmed Resolved Participant Plan.
//
// The projection is deliberately pure: no database, filesystem, staging
// state, or exact-artifact concerns. Plan validation, Profile resolution,
// duplicate gating, and artifact finalization stay with the paths that own
// them.
import type {
	ConversationControlSeed,
	ConversationCreationMessage,
	ConversationDataEntry,
	ConversationParticipantSeed,
	ParticipantDefinition,
	ParticipantDefinitionPrompt,
} from "../conversation/types";
import {
	IMPORT_KEYS,
	IMPORT_NAMESPACE,
	type SillyTavernDecodedImportSource,
	type SillyTavernExactAuthor,
	type SillyTavernImportReport,
} from "./adapter/types";

// The blank captured author's proposed Participant-name default lives in
// shared so the server projection and the client flow label cannot drift.
import { UNKNOWN_IMPORTED_AUTHOR_NAME } from "../../shared/imported-author";

export { UNKNOWN_IMPORTED_AUTHOR_NAME };

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

export const emptyImportedDefinition = (name: string): ParticipantDefinition => ({
	name,
	prompt: emptyImportedPrompt(),
	openings: [],
});

// Deterministic import Control from the resolved Participant count: the
// first resolved Participant becomes human, the second model, and later
// Participants stay unseated. A one-Participant import reserves only the
// human seat so that adding the missing Participant later preserves it and
// fills the model seat; zero Participants commit with no Control (both seats
// stay incomplete). The projection derives Control from the resolution
// itself; resolutions carry no Control field.
export const deterministicImportControl = (
	groupCount: number,
): ConversationControlSeed | undefined => {
	if (groupCount === 0) return undefined;
	if (groupCount === 1) return { human: 0 };
	return { human: 0, model: 1 };
};

// One initial author group keyed on the resolved (trimmed) captured author
// name. The exact raw captured value stays untouched in preserved source
// data (`author.name` entry and canonical archive); grouping by the resolved
// value never reinterprets roles, `is_user`, or the literal `Writer` name.
export interface ImportAuthorGroup {
	// The trimmed captured author name; null for the single
	// blank/whitespace-only group.
	key: string | null;
	// 1-based record positions whose Messages belong to this group.
	positions: number[];
	// Variant count of each retained Message, parallel to `positions`.
	variantCounts: number[];
}

// The resolved group key: the trimmed captured author name, or null for the
// single blank/whitespace-only group. Grouping by the resolved value — never
// by `is_user`, header roles, or the literal `Writer` name — gives one
// Participant per exact resolved author group in first-appearance order.
const authorGroupKey = (rawName: string): string | null => {
	const trimmed = rawName.trim();
	return trimmed === "" ? null : trimmed;
};

// The single author-grouping primitive. Both import paths consume it: the
// Default Import Policy groups on it directly, and the staged preview builds
// its initial groups from it (the user then merges or splits whole Messages
// through the Resolved Participant Plan). Whitespace variants and every
// blank captured name collapse into one group each; case and Unicode stay
// distinct, and nothing is case-folded, aliased, merged, or split beyond
// that.
export const groupImportedAuthors = (
	authors: readonly SillyTavernExactAuthor[],
): ImportAuthorGroup[] => {
	const indexByKey = new Map<string | null, number>();
	const groups: ImportAuthorGroup[] = [];
	for (const author of authors) {
		const key = authorGroupKey(author.name);
		let index = indexByKey.get(key);
		if (index === undefined) {
			index = groups.length;
			indexByKey.set(key, index);
			groups.push({ key, positions: [], variantCounts: [] });
		}
		// SAFETY: the index was recorded when that group was pushed above,
		// so it always refers to an existing group.
		const group = groups[index] as ImportAuthorGroup;
		group.positions.push(author.position);
		group.variantCounts.push(author.variantCount);
	}
	return groups;
};

// One resulting native Participant in the resolution: the complete
// Definition, optional Character Provenance, and the staged-only
// create-with-Character flag. The developer path's Default Import Policy
// always yields ad-hoc (Chat-only) Participants with empty definitions.
export interface ImportProjectionParticipant {
	definition: ParticipantDefinition;
	sourceCharacterId?: number | undefined;
	createCharacter?: boolean | undefined;
}

// The resolution input to the Import Projection: an ordered Participant set
// plus the per-Message ownership the projection stamps onto every Message.
// This is data, never a policy implementation — the projection stays the
// only place native creation data is assembled, and tests can compare
// different resolutions through one `projectImport`.
export interface ImportProjectionResolution {
	participants: readonly ImportProjectionParticipant[];
	// 1-based record position → zero-based Participant index. Must assign
	// every retained position exactly once.
	messageOwners: ReadonlyMap<number, number>;
}

// The Default Import Policy: the developer import's implicit
// author-resolution rules expressed as an Import Projection resolution. One
// Participant per trimmed author group in first-appearance order with an
// empty imported Definition and the shared blank-placeholder name, and the
// exact Message-to-Participant mapping the developer command always
// committed. The Staged Import never uses this function; it builds its
// resolution from the user-confirmed Resolved Participant Plan instead.
export const defaultImportResolution = (
	decoded: Pick<SillyTavernDecodedImportSource, "authors">,
): ImportProjectionResolution => {
	const groups = groupImportedAuthors(decoded.authors);
	const messageOwners = new Map<number, number>();
	groups.forEach((group, index) => {
		for (const position of group.positions) {
			messageOwners.set(position, index);
		}
	});
	return {
		participants: groups.map((group) => ({
			definition: emptyImportedDefinition(group.key ?? UNKNOWN_IMPORTED_AUTHOR_NAME),
		})),
		messageOwners,
	};
};

export interface ImportProjectionDuplicateMatch {
	id: number;
	name: string;
}

// Prior-import evidence classified by its match kind. Exact matches (raw
// SHA-256) and related matches (declared integrity only) both produce one
// independent-copy warning; only exact matches demand the staged
// confirmation gate, which stays with the Staged Import.
export interface ImportProjectionDuplicateEvidence {
	exact: readonly ImportProjectionDuplicateMatch[];
	related: readonly ImportProjectionDuplicateMatch[];
}

// One copy warning per matching prior Chat, mirroring the wording both
// import paths always used. Each warning names an independent copy: import
// never deduplicates, matches, or reuses prior Chats.
const duplicateCopyWarnings = (
	duplicates: ImportProjectionDuplicateEvidence,
): string[] =>
	[...duplicates.exact, ...duplicates.related].map(
		(match) =>
			`Source was already imported as chat ${match.id} ("${match.name}"); this import creates an independent copy.`,
	);

// The native creation data the projection produces: Participants (with
// provenance flags), derived Control, stamped Messages, and the complete
// Conversation-scoped data entry set. The caller supplies the Chat name and
// the exact-artifact metadata; staging, plan validation, Profile resolution,
// duplicate gating, and artifact storage never enter this module.
export interface ProjectedImport {
	input: {
		participants: (ConversationParticipantSeed & {
			createCharacter?: boolean | undefined;
		})[];
		control: ConversationControlSeed | undefined;
		messages: ConversationCreationMessage[];
		data: ConversationDataEntry[];
	};
	report: SillyTavernImportReport;
}

// Conversation-scoped entries derived from the final report. They are built
// by the projection after duplicate-warning composition so the persisted
// warnings and report match the Conversation they are stored with. The
// namespace is import-owned (shared/import-data): these entries commit
// through the creation seam, and the generic put-data/delete-data commands
// can never address them afterwards.
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

// The canonical Import Projection: maps decoded source and one resolution
// into native creation data. It stamps every retained Message with its
// resolved Participant, derives Control deterministically from the resolved
// Participant count, and assembles the final report and data entries —
// archive and source-identity entries from the decode, plus the composed
// warnings and JSON report. Every Message must be assigned; resolutions
// guarantee it by construction (grouping for the default policy, plan
// validation for the staged path).
export function projectImport(
	decoded: SillyTavernDecodedImportSource,
	resolution: ImportProjectionResolution,
	duplicates: ImportProjectionDuplicateEvidence,
): ProjectedImport {
	const report: SillyTavernImportReport = {
		...decoded.report,
		warnings: [...decoded.report.warnings, ...duplicateCopyWarnings(duplicates)],
	};
	const messages = decoded.messages.map((message, index) => {
		// SAFETY: authors is the parallel per-record projection of messages,
		// so the author row for this Message always exists.
		const author = decoded.authors[index] as SillyTavernExactAuthor;
		// SAFETY: every resolution assigns every retained position to
		// exactly one Participant (grouping for the default policy, plan
		// validation for the staged path).
		const owner = resolution.messageOwners.get(author.position) as number;
		return { ...message, authorParticipantIndex: owner };
	});

	return {
		input: {
			participants: resolution.participants.map((participant) => ({
				definition: participant.definition,
				sourceCharacterId: participant.sourceCharacterId,
				createCharacter: participant.createCharacter,
			})),
			control: deterministicImportControl(resolution.participants.length),
			messages,
			data: [...decoded.data, ...importReportEntries(report)],
		},
		report,
	};
}
