import type { LoreEntryFields } from "../../shared/contract/lorebook";
import { InvalidLorebookExpressionError } from "./errors";

/** ==[HUMAN APPROVED]== A complete selected Message. Matching never receives concatenated history. */
export interface LoreScanMessage {
	/** ==[HUMAN APPROVED]== Null identifies the pending Send text captured before a Message exists. */
	readonly id?: number | null;
	readonly content: string;
}

export interface LoreSemanticMatch {
	readonly trigger: string;
	readonly score: number;
	readonly sentence: string;
}

export interface LoreSemanticEvaluation {
	/** ==[HUMAN APPROVED]== A complete semantic pass was available for this attempt. */
	readonly available: boolean;
	readonly matches?: readonly LoreSemanticMatch[];
	readonly threshold: number;
	readonly fallbackReason?: string;
}

export interface LoreConditionEvidence {
	readonly matched: boolean;
	readonly matchedExpressions: readonly string[];
	readonly missingExpressions: readonly string[];
}

export interface LoreEntryMatch {
	readonly active: boolean;
	readonly skipped: boolean;
	readonly fallback: boolean;
	readonly primary: LoreConditionEvidence;
	readonly secondary: {
		readonly requireAny: LoreConditionEvidence;
		readonly requireAll: LoreConditionEvidence;
		readonly excludeAny: LoreConditionEvidence;
		readonly excludeAll: LoreConditionEvidence;
	};
	readonly semantic: {
		readonly available: boolean;
		readonly matched: boolean;
		readonly threshold: number | null;
		readonly matches: readonly LoreSemanticMatch[];
		readonly fallbackReason?: string;
	};
	readonly reasons: readonly string[];
}

const DEFAULT_SEMANTIC_THRESHOLD = 0.7;
const WORD = /[\p{L}\p{N}_]/u;
const NO_SEMANTIC_MATCHES: readonly LoreSemanticMatch[] = [];

const condition = (
	matchedExpressions: readonly string[],
	expressions: readonly string[],
): LoreConditionEvidence => ({
	matched: matchedExpressions.length > 0,
	matchedExpressions,
	missingExpressions: expressions.filter((expression) => !matchedExpressions.includes(expression)),
});

const isWord = (character: string | undefined): boolean => character !== undefined && WORD.test(character);

const literalMatches = (message: string, expression: string, caseSensitive: boolean, wholeWord: boolean): boolean => {
	if (expression.length === 0) return false;
	const source = caseSensitive ? message : message.toLocaleLowerCase();
	const needle = caseSensitive ? expression : expression.toLocaleLowerCase();
	let offset = source.indexOf(needle);
	while (offset >= 0) {
		if (!wholeWord || (!isWord(source[offset - 1]) && !isWord(source[offset + needle.length]))) return true;
		offset = source.indexOf(needle, offset + Math.max(1, needle.length));
	}
	return false;
};

const slashPattern = (expression: string): { source: string; flags: string } | undefined => {
	if (!expression.startsWith("/")) return undefined;
	let escaped = false;
	for (let index = expression.length - 1; index > 0; index -= 1) {
		const character = expression[index];
		if (character !== "/" || escaped) {
			escaped = character === "\\" && !escaped;
			continue;
		}
		return { source: expression.slice(1, index), flags: expression.slice(index + 1) };
	}
	throw new InvalidLorebookExpressionError(expression);
};

const regexFor = (expression: string, entry: LoreEntryFields): RegExp => {
	const parsed = slashPattern(expression);
	const flags = parsed?.flags || entry.regexFlags;
	const effectiveFlags = entry.caseSensitive || flags.includes("i") ? flags : `${flags}i`;
	try {
		return new RegExp(parsed?.source ?? expression, effectiveFlags);
	} catch (cause) {
		throw new InvalidLorebookExpressionError(expression, cause);
	}
};

export const validateLorebookExpressions = (entry: LoreEntryFields): void => {
	if (entry.keywordMode !== "regex") {
		if (entry.regexFlags !== "") throw new InvalidLorebookExpressionError(entry.regexFlags);
		return;
	}
	try {
		new RegExp("", entry.regexFlags);
	} catch (cause) {
		throw new InvalidLorebookExpressionError(entry.regexFlags, cause);
	}
	for (const expression of [
		...entry.keywords,
		...entry.requireAny,
		...entry.requireAll,
		...entry.excludeAny,
		...entry.excludeAll,
	]) regexFor(expression, entry);
};

const expressionMatches = (messages: readonly LoreScanMessage[], expression: string, entry: LoreEntryFields): boolean =>
	entry.keywordMode === "regex"
		? messages.some((message) => regexFor(expression, entry).test(message.content))
		: messages.some((message) => literalMatches(message.content, expression, entry.caseSensitive, entry.wholeWord));

const matchedExpressions = (
	messages: readonly LoreScanMessage[],
	expressions: readonly string[],
	entry: LoreEntryFields,
): string[] => expressions.filter((expression) => expressionMatches(messages, expression, entry));

const secondaryEvidence = (
	messages: readonly LoreScanMessage[],
	entry: LoreEntryFields,
) => {
	const requireAnyMatches = matchedExpressions(messages, entry.requireAny, entry);
	const requireAllMatches = matchedExpressions(messages, entry.requireAll, entry);
	const excludeAnyMatches = matchedExpressions(messages, entry.excludeAny, entry);
	const excludeAllMatches = matchedExpressions(messages, entry.excludeAll, entry);
	return {
		requireAny: {
			...condition(requireAnyMatches, entry.requireAny),
			matched: entry.requireAny.length === 0 || requireAnyMatches.length > 0,
		},
		requireAll: {
			...condition(requireAllMatches, entry.requireAll),
			matched: requireAllMatches.length === entry.requireAll.length,
		},
		excludeAny: {
			...condition(excludeAnyMatches, entry.excludeAny),
			matched: excludeAnyMatches.length === 0,
		},
		excludeAll: {
			...condition(excludeAllMatches, entry.excludeAll),
			// ==[HUMAN APPROVED]== Exclude-all vetoes only when every exclusion is present.
			matched: entry.excludeAll.length === 0 || excludeAllMatches.length < entry.excludeAll.length,
		},
	};
};

const semanticEvidence = (
	entry: LoreEntryFields,
	evaluation: LoreSemanticEvaluation | undefined,
) => {
	const threshold = entry.semanticThreshold ?? evaluation?.threshold ?? DEFAULT_SEMANTIC_THRESHOLD;
	if (entry.semanticTriggers.length === 0) return {
		available: evaluation?.available ?? true,
		matched: false,
		threshold: null,
		matches: NO_SEMANTIC_MATCHES,
		fallbackReason: evaluation?.fallbackReason,
	};
	if (evaluation?.available !== true) return {
		available: false,
		matched: false,
		threshold,
		matches: NO_SEMANTIC_MATCHES,
		fallbackReason: evaluation?.fallbackReason,
	};
	const matches = (evaluation.matches ?? []).filter((match) => entry.semanticTriggers.includes(match.trigger));
	return { available: true, matched: matches.some((match) => match.score >= threshold), threshold, matches, fallbackReason: evaluation.fallbackReason };
};

/** ==[HUMAN APPROVED]==
 * Evaluate one entry against a captured scan window. The lexical pass is always
 * message-bounded; only the semantic adapter may provide sentence-level evidence.
 */
export const matchLoreEntry = (
	entry: LoreEntryFields,
	messages: readonly LoreScanMessage[],
	semantic?: LoreSemanticEvaluation,
): LoreEntryMatch => {
	const empty = condition([], []);
	if (!entry.enabled) return {
		active: false,
		skipped: true,
		fallback: false,
		primary: empty,
		secondary: { requireAny: empty, requireAll: empty, excludeAny: empty, excludeAll: empty },
		semantic: { available: semantic?.available ?? true, matched: false, threshold: null, matches: [] },
		reasons: ["disabled"],
	};
	const secondary = secondaryEvidence(messages, entry);
	const semanticResult = semanticEvidence(entry, semantic);
	const fallback = entry.semanticTriggers.length > 0 && semantic?.available !== true;
	const lexicalMatches = matchedExpressions(messages, entry.keywords, entry);
	const lexical = condition(lexicalMatches, entry.keywords);
	const hasKeywords = entry.keywords.length > 0;
	const hasSemantic = entry.semanticTriggers.length > 0;
	const primaryMatched = hasKeywords && lexical.matched;
	const semanticMatched = hasSemantic && semanticResult.matched;
	const primary = {
		...lexical,
		matched: fallback ? primaryMatched : entry.matchOperator === "and" && hasKeywords && hasSemantic
			? primaryMatched && semanticMatched
			: primaryMatched || semanticMatched,
	};
	const reasons: string[] = [];
	if (entry.always) reasons.push("always");
	else if (!hasKeywords && (!hasSemantic || fallback)) reasons.push("no matching trigger");
	else if (fallback) reasons.push("keyword fallback");
	if (!secondary.requireAny.matched) reasons.push("require-any failed");
	if (!secondary.requireAll.matched) reasons.push("require-all failed");
	if (!secondary.excludeAny.matched) reasons.push("exclude-any matched");
	if (!secondary.excludeAll.matched) reasons.push("exclude-all matched");
	const active = entry.always || (primary.matched && Object.values(secondary).every((e) => e.matched));
	if (!active && !entry.always && hasSemantic && fallback && !hasKeywords) reasons.push("semantic-only entry skipped during keyword fallback");
	return {
		active,
		skipped: false,
		fallback,
		primary,
		secondary,
		semantic: semanticResult,
		reasons,
	};
};

const SENTENCE_ABBREVIATIONS = new Set([
	"a.m", "apr", "aug", "dec", "dr", "e.g", "etc", "feb", "i.e", "jan", "jr", "mar", "mr", "mrs", "ms", "nov", "oct", "p.m", "prof", "sep", "sept", "sr", "st", "vs",
]);

const isLetter = (character: string | undefined): boolean => character !== undefined && /\p{L}/u.test(character);
const isDigit = (character: string | undefined): boolean => character !== undefined && /\d/u.test(character);

const periodToken = (content: string, periodIndex: number): string => {
	let start = periodIndex;
	while (start > 0 && !/\s/u.test(content[start - 1] ?? "")) start -= 1;
	return content.slice(start, periodIndex).replace(/^[^\p{L}\p{N}]+/u, "").toLocaleLowerCase();
};

const periodEndsSentence = (content: string, periodIndex: number): boolean => {
	const previous = content[periodIndex - 1];
	const next = content[periodIndex + 1];
	if (next === ".") return false;
	if (isDigit(previous) && isDigit(next)) return false;
	const token = periodToken(content, periodIndex);
	if (SENTENCE_ABBREVIATIONS.has(token)) return false;
	// ==[HUMAN APPROVED]== A single capital and dotted initials (A. Smith, A.B. Smith) are names, not sentences.
	if (token.length === 1 && isLetter(content[periodIndex - 1]) && content[periodIndex - 1] === content[periodIndex - 1]?.toUpperCase()) return false;
	if (/^(?:[a-z]\.)+[a-z]?$/u.test(token)) return false;
	return true;
};

/** ==[HUMAN APPROVED]== Split only for semantic adapters; lexical matching receives complete Messages. */
export const splitLoreSentences = (content: string): string[] => {
	const sentences: string[] = [];
	let start = 0;
	const append = (end: number): void => {
		const sentence = content.slice(start, end).trim();
		if (sentence.length > 0) sentences.push(sentence);
	};
	for (let index = 0; index < content.length; index += 1) {
		const character = content[index];
		if (character === "\n" || character === "\r") {
			append(index);
			start = index + 1;
			continue;
		}
		if (character !== "." && character !== "!" && character !== "?" && character !== "。" && character !== "！" && character !== "？") continue;
		if (character === "." && !periodEndsSentence(content, index)) continue;
		const next = content[index + 1];
		if (next !== undefined && !/\s/u.test(next)) continue;
		append(index + 1);
		start = index + 1;
	}
	append(content.length);
	return sentences;
};
