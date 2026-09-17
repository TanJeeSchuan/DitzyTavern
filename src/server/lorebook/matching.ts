import type { LoreEntryFields } from "../../shared/contract/lorebook";
import { InvalidLorebookExpressionError } from "./errors";

/** ==[HUMAN APPROVED]== A complete selected Message. Matching never receives concatenated history. */
export interface LoreScanMessage {
	readonly id?: number;
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
	};
	if (evaluation?.available !== true) return {
		available: false,
		matched: false,
		threshold,
		matches: NO_SEMANTIC_MATCHES,
	};
	const matches = (evaluation.matches ?? []).filter((match) =>
		entry.semanticTriggers.includes(match.trigger) && match.score >= threshold);
	return { available: true, matched: matches.length > 0, threshold, matches };
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

/** ==[HUMAN APPROVED]== Split only for semantic adapters; lexical matching receives complete Messages. */
export const splitLoreSentences = (content: string): string[] => content
	.split(/(?<=[.!?。！？])\s+|\n+/u)
	.map((sentence) => sentence.trim())
	.filter((sentence) => sentence.length > 0);

export const DEFAULT_LORE_SEMANTIC_THRESHOLD = DEFAULT_SEMANTIC_THRESHOLD;
