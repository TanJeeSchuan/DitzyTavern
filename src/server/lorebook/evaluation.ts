import type { Database } from "bun:sqlite";
import type { PromptLoreEntry } from "../prompt-compiler";
import type { LoreActivationRecord } from "../../shared/contract/lore-activation";
import type { GenerationJsonValue } from "../../shared/generation-json";
import type { Lorebook } from "../../shared/contract/lorebook";
import { readLorebook } from "./library";
import { matchLoreEntry, type LoreEntryMatch, type LoreScanMessage } from "./matching";
import { captureLoreScanWindow, type LoreScanSourceMessage } from "./scan";
import { readLoreSettings, readLorebookAttachmentEligibility, type LoreAttachmentEligibility } from "./attachments";
import { captureSemanticSettings, evaluateSemanticLore, type SemanticSettingsSnapshot } from "./semantic";
import type { ConnectionSettingsModuleOptions } from "../connection-settings";
import type { ModelFetch } from "../model-client";

export interface ScopedLoreEvaluation {
	readonly candidates: readonly PromptLoreEntry[];
	readonly activation: LoreActivationRecord;
	readonly scan: readonly LoreScanMessage[];
	readonly matches: readonly ScopedLoreMatch[];
	readonly allowance: number;
	/** ==[HUMAN APPROVED]== Reuse captured Lore inputs so asynchronous semantic work cannot observe later edits. */
	readonly sources?: ScopedLoreSources;
}

export interface ScopedLoreMatch {
	readonly bookId: number;
	readonly bookName: string;
	readonly entryId: number;
	readonly title: string;
	readonly match: LoreEntryMatch;
}

export interface ScopedLoreBookSource {
	readonly book: Lorebook;
	/** ==[HUMAN APPROVED]== All eligible uses retained for the existing eligibility evidence. */
	readonly attachmentIds: readonly number[];
	/** ==[HUMAN APPROVED]== The first eligible use represents this book after book-identity deduplication. */
	readonly selectedAttachmentId: number;
	/** ==[HUMAN APPROVED]== Later eligible uses of the same book are not evaluated again. */
	readonly deduplicatedAttachmentIds: readonly number[];
}

export interface LoreBookAttachmentSelectionEvidence {
	readonly [key: string]: GenerationJsonValue;
	readonly selectedAttachmentId: number;
	readonly deduplicatedAttachmentIds: readonly number[];
	readonly reason: string;
}

const attachmentSelectionEvidence = (source: Pick<ScopedLoreBookSource, "selectedAttachmentId" | "deduplicatedAttachmentIds">): LoreBookAttachmentSelectionEvidence => ({
	selectedAttachmentId: source.selectedAttachmentId,
	deduplicatedAttachmentIds: [...source.deduplicatedAttachmentIds],
	reason: source.deduplicatedAttachmentIds.length > 0
		? "The first eligible use was selected; later eligible uses were deduplicated because this book is evaluated once by book identity."
		: "The only eligible use was selected for this book.",
});

// @approved
//  The persisted lore evidence. The book strip drops its entries array
// (the entry is carried beside it), the stored entry passes through as the
// JSON value it already is, and the per-condition spread keeps the
// interface-typed match evidence assignable to the closed JSON type; the
// semantic projection closes an absent fallbackReason to null exactly as
// the match stores it.
const semanticEvidence = (semantic: LoreEntryMatch["semantic"]): GenerationJsonValue => {
	const { fallbackReason, ...available } = semantic;
	return {
		...available,
		matches: semantic.matches.map((match) => ({ ...match })),
		fallbackReason: fallbackReason ?? null,
	};
};

const evidenceFor = (input: {
	book: Lorebook;
	entry: Lorebook["entries"][number];
	match: LoreEntryMatch;
	attachmentIds: readonly number[];
	attachmentSelection: LoreBookAttachmentSelectionEvidence;
	messages: readonly LoreScanMessage[];
}): GenerationJsonValue => {
	const { entries: _entries, ...book } = input.book;
	return {
		book,
		entry: { ...input.entry },
		attachmentIds: input.attachmentIds,
		attachmentSelection: input.attachmentSelection,
		messages: input.messages.map((message) => ({ id: message.id ?? null, content: message.content })),
		match: {
			...input.match,
			primary: { ...input.match.primary },
			secondary: {
				requireAny: { ...input.match.secondary.requireAny },
				requireAll: { ...input.match.secondary.requireAll },
				excludeAny: { ...input.match.secondary.excludeAny },
				excludeAll: { ...input.match.secondary.excludeAll },
			},
			semantic: semanticEvidence(input.match.semantic),
		},
	} satisfies GenerationJsonValue;
};

interface ScopedLoreInput {
	database: Database;
	conversationId: number;
	messages: readonly LoreScanSourceMessage[];
	pendingHumanText?: string;
	beforeMessageId?: number;
	connectionSettings?: ConnectionSettingsModuleOptions;
}

export interface ScopedLoreSources {
	scanMessages: readonly LoreScanMessage[];
	eligibleUses: LoreAttachmentEligibility[];
	books: readonly ScopedLoreBookSource[];
	allowance: number;
	semanticSettings: SemanticSettingsSnapshot;
}

const collectSources = (input: ScopedLoreInput): ScopedLoreSources => {
	const semanticSettings = captureSemanticSettings(input.database, input.connectionSettings);
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
	const books: ScopedLoreBookSource[] = [];
	for (const [bookId, attachmentIds] of eligibleByBook) {
		const book = readLorebook(input.database, bookId);
		if (book === undefined) continue;
		const [selectedAttachmentId, ...deduplicatedAttachmentIds] = attachmentIds;
		if (selectedAttachmentId === undefined) continue;
		books.push({ book, attachmentIds, selectedAttachmentId, deduplicatedAttachmentIds });
	}
	return {
		scanMessages,
		eligibleUses,
		books,
		allowance: settings.allowance,
		semanticSettings,
	};
};

const assembleEvaluation = (sources: ScopedLoreSources, semantic?: import("./matching").LoreSemanticEvaluation): ScopedLoreEvaluation => {
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
		books: sources.books.map((source) => ({
			bookId: source.book.id,
			...attachmentSelectionEvidence(source),
		})),
	}];
	const candidates: PromptLoreEntry[] = [];
	const matches: ScopedLoreMatch[] = [];
	let hasSemanticTriggers = false;
	for (const source of sources.books) {
		const { book, attachmentIds } = source;
		for (const entry of book.entries) {
			hasSemanticTriggers ||= entry.enabled && entry.semanticTriggers.length > 0;
			const matched = matchLoreEntry(entry, sources.scanMessages, semantic);
			matches.push({ bookId: book.id, bookName: book.name, entryId: entry.id, title: entry.title, match: matched });
			evidence.push(evidenceFor({ book, entry, match: matched, attachmentIds, attachmentSelection: attachmentSelectionEvidence(source), messages: sources.scanMessages }));
			if (!matched.active) continue;
			candidates.push({
				content: entry.content,
				always: entry.always,
				priority: entry.priority,
				bookOrder: book.id,
				entryOrder: entry.position,
				bookId: book.id,
				entryId: entry.id,
			});
		}
	}
	const mode = sources.eligibleUses.some((use) => use.eligible)
		? hasSemanticTriggers && semantic?.available !== true ? "keyword-fallback" : "semantic"
		: "none";
	return {
		candidates,
		scan: sources.scanMessages,
		matches,
		allowance: sources.allowance,
		sources,
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
	return assembleEvaluation(collectSources(input), undefined);
};

/** ==[HUMAN APPROVED]==
 * Async semantic seam used by Generation preparation and the match tester. Semantic matching is
 * performed once for the captured window; any incomplete provider pass is represented as one
 * unavailable result so every entry follows the same keyword fallback policy.
 */
export const evaluateScopedLoreAsync = async (input: ScopedLoreInput & { fetch?: ModelFetch; signal?: AbortSignal }, capturedSources?: ScopedLoreSources): Promise<ScopedLoreEvaluation> => {
	const sources = capturedSources ?? collectSources(input);
	const semantic = await evaluateSemanticLore({
		entries: sources.books.flatMap(({ book }) => book.entries),
		messages: sources.scanMessages,
		settings: sources.semanticSettings,
		fetch: input.fetch,
		signal: input.signal,
	});
	return assembleEvaluation(sources, semantic);
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
	matches: [],
});
