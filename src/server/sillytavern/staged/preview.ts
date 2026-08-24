import type { Database } from "bun:sqlite";
import {
	createCharacterLibraryModule,
	type CharacterSummary,
} from "../../character-library";
import type {
	SillyTavernChatInspection,
	SillyTavernExactAuthor,
} from "../adapter";
import { chatNameFromFilename } from "../import";
import { findPriorImportsBySource } from "../prior-imports";
import { UNKNOWN_IMPORTED_AUTHOR_NAME } from "./types";
import type {
	ChatImportDuplicateMatch,
	ChatImportGroup,
	ChatImportPreview,
	ChatImportSuggestion,
	SuggestionMatchKind,
} from "./types";

// Name-only matching: SillyTavern roles, header fields, avatar data,
// Message content, and `is_user` never influence a Character candidate.
const levenshtein = (a: string, b: string): number => {
	const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i += 1) {
		const current = [i];
		for (let j = 1; j <= b.length; j += 1) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			current[j] = Math.min(
				current[j - 1]! + 1,
				previous[j]! + 1,
				previous[j - 1]! + cost,
			);
		}
		previous.splice(0, previous.length, ...current);
	}
	return previous[b.length]!;
};

const suggestionTier = (
	candidateName: string,
	key: string,
): SuggestionMatchKind | null => {
	if (candidateName === key) return "exact";
	if (candidateName.toLocaleLowerCase() === key.toLocaleLowerCase()) {
		return "case-insensitive";
	}
	// Fuzzy tier: a bounded normalized edit distance. Names too dissimilar
	// never cross into the suggestion set.
	const threshold = Math.max(
		1,
		Math.floor(Math.max(candidateName.length, key.length) * 0.25),
	);
	return levenshtein(candidateName, key) <= threshold ? "fuzzy" : null;
};

const tierRank = (tier: SuggestionMatchKind): number =>
	tier === "exact" ? 0 : tier === "case-insensitive" ? 1 : 2;

// Picks the strongest candidate by exact, then case-insensitive, then fuzzy
// tier. The library list is already library-ordered (pinned, then name,
// then id), so the first candidate of the winning tier is the strongest.
const strongestSuggestion = (
	key: string,
	characters: readonly CharacterSummary[],
): ChatImportSuggestion | null => {
	let best: { name: string; characterId: number; tier: SuggestionMatchKind } | null =
		null;
	for (const character of characters) {
		const tier = suggestionTier(character.name, key);
		if (tier === null) continue;
		if (best === null || tierRank(tier) < tierRank(best.tier)) {
			best = {
				name: character.name,
				characterId: character.id,
				tier,
			};
		}
	}
	return best === null
		? null
		: { characterId: best.characterId, name: best.name, match: best.tier, confirmed: false };
};

const isBlankAuthor = (key: string): boolean => key.trim() === "";

const buildGroups = (
	authors: readonly SillyTavernExactAuthor[],
	characters: readonly CharacterSummary[],
): ChatImportGroup[] => {
	const groups: {
		key: string;
		positions: number[];
		variantCounts: number[];
	}[] = [];
	const indexByKey = new Map<string, number>();
	for (const author of authors) {
		let index = indexByKey.get(author.name);
		if (index === undefined) {
			index = groups.length;
			indexByKey.set(author.name, index);
			groups.push({ key: author.name, positions: [], variantCounts: [] });
		}
		const group = groups[index];
		if (group === undefined) continue;
		group.positions.push(author.position);
		group.variantCounts.push(author.variantCount);
	}
	return groups.map((group) => ({
		key: group.key,
		isBlank: isBlankAuthor(group.key),
		messagePositions: group.positions,
		messageVariantCounts: group.variantCounts,
		messageCount: group.positions.length,
		variantCount: group.variantCounts.reduce((total, count) => total + count, 0),
		participantNameDefault: isBlankAuthor(group.key)
			? UNKNOWN_IMPORTED_AUTHOR_NAME
			: group.key,
		suggestion: isBlankAuthor(group.key)
			? null
			: strongestSuggestion(group.key, characters),
	}));
};

const toDuplicateMatch = (match: { id: number; name: string }): ChatImportDuplicateMatch => ({
	id: match.id,
	name: match.name,
});

export const buildPreview = (
	database: Database,
	originalFilename: string,
	byteLength: number,
	sha256: string,
	inspection: SillyTavernChatInspection,
): ChatImportPreview => {
	const characters = createCharacterLibraryModule(database).list();
	const matches = findPriorImportsBySource(database, inspection.report.source);
	return {
		title: chatNameFromFilename(originalFilename),
		originalFilename,
		sha256,
		byteLength,
		integrity: inspection.report.source.integrity ?? null,
		counts: { ...inspection.report.counts },
		warnings: [...inspection.report.warnings],
		groups: buildGroups(inspection.authors, characters),
		duplicates: {
			exact: matches.filter((match) => match.kind === "exact").map(toDuplicateMatch),
			related: matches.filter((match) => match.kind === "related").map(toDuplicateMatch),
		},
	};
};
