// @approved
//  Canonical Import Projection: the pure source-to-native derivation shared
// by the developer import and the Staged Import. It owns author ownership,
// Message stamping, Control derivation, report/data entries, and warnings;
// the paths that own staging, Profile resolution, and artifact storage keep
// their concerns out of it.
import type {
	ConversationControlSeed,
	ConversationCreationMessage,
	ConversationDataEntry,
	ConversationParticipantSeed,
	ParticipantDefinition,
} from "../conversation";
import { emptyPromptChannels } from "../../shared/definition";
import {
	IMPORT_KEYS,
	IMPORT_NAMESPACE,
	type SillyTavernDecodedImportSource,
	type SillyTavernExactAuthor,
	type SillyTavernImportReport,
} from "./adapter/types";
import type { ChatImportDuplicateEvidence } from "../../shared/contract/chat-import";

// @approved
//  The blank captured author's proposed Participant-name default lives in
// shared so the server projection and the client flow label cannot drift.
import { UNKNOWN_IMPORTED_AUTHOR_NAME } from "../../shared/imported-author";

export { UNKNOWN_IMPORTED_AUTHOR_NAME };

// @approved
//  Imported Participants start with an empty typed Prompt and no openings:
// the history itself is the preserved record.
export const emptyImportedDefinition = (name: string): ParticipantDefinition => ({
	name,
	prompt: emptyPromptChannels(),
	openings: [],
});

// @approved
//  Zero-, one-, and two-Participant imports start at the human seat so that
// adding a missing Participant later preserves it. Resolutions carry no
// Control field, so the projection derives Control from the count alone.
export const deterministicImportControl = (
	groupCount: number,
): ConversationControlSeed | undefined => {
	if (groupCount === 0) return undefined;
	if (groupCount === 1) return { human: 0 };
	return { human: 0, model: 1 };
};

// @approved
//  One initial author group keyed on the resolved (trimmed) captured author
// name.
export interface ImportAuthorGroup {
	key: string | null;
	positions: number[];
	variantCounts: number[];
}

// @approved
//  Both import paths group on this one primitive; whitespace variants and
// blank names collapse into one group each, and nothing is case-folded or
// aliased.
export const groupImportedAuthors = (
	authors: readonly SillyTavernExactAuthor[],
): ImportAuthorGroup[] => {
	const indexByKey = new Map<string | null, number>();
	const groups: ImportAuthorGroup[] = [];
	for (const author of authors) {
		const trimmed = author.name.trim();
		const key = trimmed === "" ? null : trimmed;
		let index = indexByKey.get(key);
		if (index === undefined) {
			index = groups.length;
			indexByKey.set(key, index);
			groups.push({ key, positions: [], variantCounts: [] });
		}
		// @approved
		//  SAFETY: the index was recorded when that group was pushed above,
		// so it always refers to an existing group.
		const group = groups[index] as ImportAuthorGroup;
		group.positions.push(author.position);
		group.variantCounts.push(author.variantCount);
	}
	return groups;
};

// @approved
//  One resulting native Participant: the complete Definition plus the
// staged-only Character provenance flags.
export interface ImportProjectionParticipant {
	definition: ParticipantDefinition;
	sourceCharacterId?: number | undefined;
	createCharacter?: boolean | undefined;
}

// @approved
//  The ordered Participant set plus the per-Message ownership the projection
// stamps; data, never a policy implementation.
export interface ImportProjectionResolution {
	participants: readonly ImportProjectionParticipant[];
	// @approved
	//  1-based record position → zero-based Participant index, assigned once.
	messageOwners: ReadonlyMap<number, number>;
}

// @approved
//  The developer import's implicit author-resolution rules: one Participant
// per trimmed group in first-appearance order, with the exact
// Message-to-Participant mapping the command always committed. The Staged
// Import never calls this.
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

// @approved
//  One copy warning per matching prior Chat. Exact matches (raw SHA-256) and
// related matches (declared integrity only) both warn; only exact matches
// demand the staged confirmation gate, which stays with the Staged Import.
const duplicateCopyWarnings = (
	duplicates: ChatImportDuplicateEvidence,
): string[] =>
	[...duplicates.exact, ...duplicates.related].map(
		(match) =>
			`Source was already imported as chat ${match.id} ("${match.name}"); this import creates an independent copy.`,
	);

// @approved
//  The native creation data plus the report; staging, plan validation,
// Profile resolution, and artifact storage never enter this module.
export interface ProjectedImport {
	input: {
		authorNote: string;
		participants: (ConversationParticipantSeed & {
			createCharacter?: boolean | undefined;
		})[];
		control: ConversationControlSeed | undefined;
		messages: ConversationCreationMessage[];
		data: ConversationDataEntry[];
	};
	report: SillyTavernImportReport;
}

// @approved
//  Conversation-scoped entries derived from the final report, built after
// duplicate-warning composition so persisted warnings and report match. The
// namespace is import-owned: generic data commands can never address these
// entries afterwards.
export const importProvenanceEntries = (
	report: SillyTavernImportReport,
): ConversationDataEntry[] => {
	const entries: ConversationDataEntry[] = [];
	if (report.source.integrity !== undefined) {
		entries.push({
			namespace: IMPORT_NAMESPACE,
			key: IMPORT_KEYS.integrity,
			value: report.source.integrity,
		});
	}
	entries.push(
		{
			namespace: IMPORT_NAMESPACE,
			key: IMPORT_KEYS.sha256,
			value: report.source.sha256,
		},
		{
			namespace: IMPORT_NAMESPACE,
			key: IMPORT_KEYS.filename,
			value: report.source.filename,
		},
		{
			namespace: IMPORT_NAMESPACE,
			key: IMPORT_KEYS.importerVersion,
			value: report.importerVersion,
		},
		{
			namespace: IMPORT_NAMESPACE,
			key: IMPORT_KEYS.countsMessages,
			value: String(report.counts.messages),
		},
		{
			namespace: IMPORT_NAMESPACE,
			key: IMPORT_KEYS.countsVariants,
			value: String(report.counts.variants),
		},
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
	);
	return entries;
};

// @approved
//  Maps decoded source and one resolution into native creation data,
// stamping every retained Message and deriving Control from the count.
// Every Message must be assigned; the resolutions guarantee it.
export function projectImport(
	decoded: SillyTavernDecodedImportSource,
	resolution: ImportProjectionResolution,
	duplicates: ChatImportDuplicateEvidence,
): ProjectedImport {
	const report: SillyTavernImportReport = {
		...decoded.report,
		warnings: [...decoded.report.warnings, ...duplicateCopyWarnings(duplicates)],
	};
	const messages = decoded.messages.map((message, index) => {
		// @approved
		//  SAFETY: authors is the parallel per-record projection of messages,
		// so the author row for this Message always exists.
		const author = decoded.authors[index] as SillyTavernExactAuthor;
		// @approved
		//  SAFETY: every resolution assigns every retained position to
		// exactly one Participant (grouping for the default policy, plan
		// validation for the staged path).
		const owner = resolution.messageOwners.get(author.position) as number;
		return { ...message, authorParticipantIndex: owner };
	});

	return {
		input: {
			authorNote: decoded.authorNote,
			participants: resolution.participants.map((participant) => ({
				definition: participant.definition,
				sourceCharacterId: participant.sourceCharacterId,
				createCharacter: participant.createCharacter,
			})),
			control: deterministicImportControl(resolution.participants.length),
			messages,
			data: [...decoded.data, ...importProvenanceEntries(report)],
		},
		report,
	};
}
