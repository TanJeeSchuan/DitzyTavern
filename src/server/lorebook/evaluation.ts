import type { Database } from "bun:sqlite";
import type { PromptLoreEntry } from "../prompt-compiler";
import type { LoreActivationRecord } from "../../shared/lore-activation";
import type { GenerationJsonValue } from "../../shared/generation-json";
import type { Lorebook } from "../../shared/contract/lorebook";
import { readLorebook } from "./library";
import { matchLoreEntry, type LoreEntryMatch, type LoreScanMessage } from "./matching";
import { captureLoreScanWindow, type LoreScanSourceMessage } from "./scan";
import { readLoreSettings, readLorebookAttachmentEligibility } from "./attachments";
import { evaluateSemanticLore } from "./semantic";
import type { ModelFetch } from "../model-client";

export interface ScopedLoreEvaluation {
	readonly candidates: readonly PromptLoreEntry[];
	readonly activation: LoreActivationRecord;
	readonly scan: readonly LoreScanMessage[];
	readonly allowance: number;
}

const evidenceFor = (input: {
	book: Lorebook;
	entryId: number;
	match: LoreEntryMatch;
	attachmentIds: readonly number[];
	messages: readonly LoreScanMessage[];
}) => {
	const semantic: GenerationJsonValue = input.match.semantic.fallbackReason === undefined
		? {
			available: input.match.semantic.available,
			matched: input.match.semantic.matched,
			threshold: input.match.semantic.threshold,
			matches: input.match.semantic.matches.map((match) => ({ trigger: match.trigger, score: match.score, sentence: match.sentence })),
		}
		: {
			available: input.match.semantic.available,
			matched: input.match.semantic.matched,
			threshold: input.match.semantic.threshold,
			matches: input.match.semantic.matches.map((match) => ({ trigger: match.trigger, score: match.score, sentence: match.sentence })),
			fallbackReason: input.match.semantic.fallbackReason,
		};
	return {
	bookId: input.book.id,
	bookName: input.book.name,
	entryId: input.entryId,
	attachmentIds: [...input.attachmentIds],
	messages: input.messages.map((message) => ({ id: message.id ?? null, content: message.content })),
	match: {
		active: input.match.active,
		skipped: input.match.skipped,
		fallback: input.match.fallback,
		primary: {
			matched: input.match.primary.matched,
			matchedExpressions: [...input.match.primary.matchedExpressions],
			missingExpressions: [...input.match.primary.missingExpressions],
		},
		secondary: {
			requireAny: { matched: input.match.secondary.requireAny.matched, matchedExpressions: [...input.match.secondary.requireAny.matchedExpressions], missingExpressions: [...input.match.secondary.requireAny.missingExpressions] },
			requireAll: { matched: input.match.secondary.requireAll.matched, matchedExpressions: [...input.match.secondary.requireAll.matchedExpressions], missingExpressions: [...input.match.secondary.requireAll.missingExpressions] },
			excludeAny: { matched: input.match.secondary.excludeAny.matched, matchedExpressions: [...input.match.secondary.excludeAny.matchedExpressions], missingExpressions: [...input.match.secondary.excludeAny.missingExpressions] },
			excludeAll: { matched: input.match.secondary.excludeAll.matched, matchedExpressions: [...input.match.secondary.excludeAll.matchedExpressions], missingExpressions: [...input.match.secondary.excludeAll.missingExpressions] },
		},
		semantic,
		reasons: [...input.match.reasons],
	},
};
};

interface ScopedLoreInput {
	database: Database;
	conversationId: number;
	messages: readonly LoreScanSourceMessage[];
	pendingHumanText?: string;
	beforeMessageId?: number;
}

interface ScopedLoreSources {
	scanMessages: readonly LoreScanMessage[];
	eligibleUses: ReturnType<typeof readLorebookAttachmentEligibility>;
	books: readonly { book: Lorebook; attachmentIds: readonly number[] }[];
	allowance: number;
}

const collectSources = (input: ScopedLoreInput): ScopedLoreSources => {
	const settings = readLoreSettings(input.database, input.conversationId);
	const scan = captureLoreScanWindow({
		messages: input.messages,
		pendingHumanText: input.pendingHumanText,
		beforeMessageId: input.beforeMessageId,
		depth: settings.scanDepth,
	});
	const scanMessages: LoreScanMessage[] = scan.map((message) => ({ id: message.id, content: message.content }));
	const eligibleUses = readLorebookAttachmentEligibility(input.database, input.conversationId);
	const eligibleByBook = new Map<number, number[]>();
	for (const use of eligibleUses) {
		if (!use.eligible) continue;
		const owners = eligibleByBook.get(use.bookId) ?? [];
		owners.push(use.id);
		eligibleByBook.set(use.bookId, owners);
	}
	const books: { book: Lorebook; attachmentIds: readonly number[] }[] = [];
	for (const [bookId, attachmentIds] of eligibleByBook) {
		const book = readLorebook(input.database, bookId);
		if (book === undefined) continue;
		books.push({ book, attachmentIds });
	}
	return { scanMessages, eligibleUses, books, allowance: settings.allowance };
};

const assembleEvaluation = (input: ScopedLoreInput, sources: ScopedLoreSources, semantic?: import("./matching").LoreSemanticEvaluation): ScopedLoreEvaluation => {
	const evidence: GenerationJsonValue[] = [{
		attachments: sources.eligibleUses.map((use) => ({
			id: use.id,
			owner: use.owner,
			ownerId: use.ownerId,
			bookId: use.bookId,
			scope: use.scope,
			enabled: use.enabled,
			eligible: use.eligible,
			reason: use.reason,
		})),
	}];
	const candidates: PromptLoreEntry[] = [];
	let hasSemanticTriggers = false;
	for (const { book, attachmentIds } of sources.books) {
		for (const entry of book.entries) {
			hasSemanticTriggers ||= entry.enabled && entry.semanticTriggers.length > 0;
			const matched = matchLoreEntry(entry, sources.scanMessages, semantic);
			evidence.push(evidenceFor({ book, entryId: entry.id, match: matched, attachmentIds, messages: sources.scanMessages }));
			if (!matched.active) continue;
			candidates.push({ content: entry.content, always: entry.always, priority: entry.priority, bookOrder: book.id, entryOrder: entry.position });
		}
	}
	const mode = sources.eligibleUses.some((use) => use.eligible)
		? hasSemanticTriggers && semantic?.available !== true ? "keyword-fallback" : "semantic"
		: "none";
	return {
		candidates,
		scan: sources.scanMessages,
		allowance: sources.allowance,
		activation: {
			version: 1,
			mode,
			evidence,
			automaticLoreText: "",
			finalLoreText: "",
			manuallyEdited: false,
		},
	};
};

/** ==[HUMAN APPROVED]== Resolve scope and run the deterministic lexical/fallback policy. */
export const evaluateScopedLore = (input: ScopedLoreInput): ScopedLoreEvaluation => {
	const sources = collectSources(input);
	return assembleEvaluation(input, sources, undefined);
};

/** ==[HUMAN APPROVED]==
 * Async semantic seam used by Generation preparation and the match tester. Semantic matching is
 * performed once for the captured window; any incomplete provider pass is represented as one
 * unavailable result so every entry follows the same keyword fallback policy.
 */
export const evaluateScopedLoreAsync = async (input: ScopedLoreInput & { fetch?: ModelFetch }): Promise<ScopedLoreEvaluation> => {
	const sources = collectSources(input);
	const semantic = await evaluateSemanticLore({
		database: input.database,
		entries: sources.books.flatMap(({ book }) => book.entries),
		messages: sources.scanMessages,
		fetch: input.fetch,
	});
	return assembleEvaluation(input, sources, semantic);
};

export const noLoreEvaluation = (): ScopedLoreEvaluation => ({
	candidates: [],
	scan: [],
	allowance: 2048,
	activation: {
		version: 1,
		mode: "none",
		evidence: [],
		automaticLoreText: "",
		finalLoreText: "",
		manuallyEdited: false,
	},
});
