import type { Database } from "bun:sqlite";
import type { PromptLoreEntry } from "../prompt-compiler";
import type { LoreActivationRecord } from "../../shared/lore-activation";
import type { GenerationJsonValue } from "../../shared/generation-json";
import type { Lorebook } from "../../shared/contract/lorebook";
import { readLorebook } from "./library";
import { matchLoreEntry, type LoreEntryMatch, type LoreScanMessage } from "./matching";
import { captureLoreScanWindow, type LoreScanSourceMessage } from "./scan";
import { readLoreSettings, readLorebookAttachmentEligibility } from "./attachments";

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
}) => ({
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
		semantic: {
			available: input.match.semantic.available,
			matched: input.match.semantic.matched,
			threshold: input.match.semantic.threshold,
			matches: input.match.semantic.matches.map((match) => ({ trigger: match.trigger, score: match.score, sentence: match.sentence })),
		},
		reasons: [...input.match.reasons],
	},
});

/** ==[HUMAN APPROVED]==
 * Resolve attachment scope before book deduplication and perform one lexical pass over the
 * captured narrative. Semantic adapters plug into this seam later; unavailable semantic data
 * intentionally uses the approved whole-attempt keyword fallback.
 */
export const evaluateScopedLore = (input: {
	database: Database;
	conversationId: number;
	messages: readonly LoreScanSourceMessage[];
	pendingHumanText?: string;
	beforeMessageId?: number;
}): ScopedLoreEvaluation => {
	const settings = readLoreSettings(input.database, input.conversationId);
	const scan = captureLoreScanWindow({
		messages: input.messages,
		pendingHumanText: input.pendingHumanText,
		beforeMessageId: input.beforeMessageId,
		depth: settings.scanDepth,
	});
	const scanMessages: LoreScanMessage[] = scan.map((message) => ({ id: message.id, content: message.content }));
	const eligibleUses = readLorebookAttachmentEligibility(input.database, input.conversationId);
	const evidence: GenerationJsonValue[] = [{
		attachments: eligibleUses.map((use) => ({
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
	const eligibleByBook = new Map<number, number[]>();
	for (const use of eligibleUses) {
		if (!use.eligible) continue;
		const owners = eligibleByBook.get(use.bookId) ?? [];
		owners.push(use.id);
		eligibleByBook.set(use.bookId, owners);
	}
	const candidates: PromptLoreEntry[] = [];
	let hasSemanticTriggers = false;
	for (const [bookId, attachmentIds] of eligibleByBook) {
		const book = readLorebook(input.database, bookId);
		if (book === undefined) continue;
		for (const entry of book.entries) {
			hasSemanticTriggers ||= entry.semanticTriggers.length > 0;
			const matched = matchLoreEntry(entry, scanMessages);
			evidence.push(evidenceFor({ book, entryId: entry.id, match: matched, attachmentIds, messages: scanMessages }));
			if (!matched.active) continue;
			candidates.push({
				content: entry.content,
				always: entry.always,
				priority: entry.priority,
				bookOrder: book.id,
				entryOrder: entry.position,
			});
		}
	}
	const mode = eligibleUses.some((use) => use.eligible)
		? hasSemanticTriggers ? "keyword-fallback" : "semantic"
		: "none";
	return {
		candidates,
		scan: scanMessages,
		allowance: settings.allowance,
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
