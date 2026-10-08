import { RE2JS } from "re2js";
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

const codePointAt = (value: string, index: number): string | undefined => {
	if (index < 0 || index >= value.length) return undefined;
	const point = value.codePointAt(index);
	return point === undefined ? undefined : String.fromCodePoint(point);
};

const codePointBefore = (value: string, index: number): string | undefined => {
	const previous = value.charCodeAt(index - 1);
	if (Number.isNaN(previous)) return undefined;
	const preceding = value.charCodeAt(index - 2);
	const paired = previous >= 0xdc00 && previous <= 0xdfff && preceding >= 0xd800 && preceding <= 0xdbff;
	return paired ? codePointAt(value, index - 2) : codePointAt(value, index - 1);
};

const isWord = (character: string | undefined): boolean => character !== undefined && WORD.test(character);

const literalMatches = (message: string, expression: string, caseSensitive: boolean, wholeWord: boolean): boolean => {
	if (expression.length === 0) return false;
	const source = caseSensitive ? message : message.toLowerCase();
	const needle = caseSensitive ? expression : expression.toLowerCase();
	let offset = source.indexOf(needle);
	while (offset >= 0) {
		if (!wholeWord || (!isWord(codePointBefore(source, offset)) && !isWord(codePointAt(source, offset + needle.length)))) return true;
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

const regexFor = (expression: string, entry: LoreEntryFields): RE2JS => {
	const parsed = slashPattern(expression);
	const flags = parsed?.flags || entry.regexFlags;
	const effectiveFlags = entry.caseSensitive || flags.includes("i") ? flags : `${flags}i`;
	const source = parsed?.source ?? expression;
	try {
		new RegExp("", effectiveFlags);
		return RE2JS.compile(
			effectiveFlags.includes("y") ? `\\A(?:${source})` : source,
			(effectiveFlags.includes("i") ? RE2JS.CASE_INSENSITIVE : 0)
				| (effectiveFlags.includes("m") ? RE2JS.MULTILINE : 0)
				| (effectiveFlags.includes("s") ? RE2JS.DOTALL : 0)
				| RE2JS.LOOKBEHINDS,
		);
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

const expressionMatches = (messages: readonly LoreScanMessage[], expression: string, entry: LoreEntryFields): boolean => {
	if (entry.keywordMode === "literal") {
		return messages.some((message) => literalMatches(message.content, expression, entry.caseSensitive, entry.wholeWord));
	}
	const regex = regexFor(expression, entry);
	return messages.some((message) => regex.test(message.content));
};

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
			// @approved
			//  Exclude-all vetoes only when every exclusion is present.
			matched: entry.excludeAll.length === 0 || excludeAllMatches.length < entry.excludeAll.length,
		},
	};
};

const semanticEvidence = (
	entry: LoreEntryFields,
	evaluation: LoreSemanticEvaluation | undefined,
) => {
	const threshold = evaluation?.threshold ?? null;
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
	return { available: true, matched: matches.some((match) => match.score >= evaluation.threshold), threshold, matches, fallbackReason: evaluation.fallbackReason };
};

/** ==[HUMAN APPROVED]==
 * Evaluate one entry against a captured scan window. The lexical pass is always
 * message-bounded.
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
