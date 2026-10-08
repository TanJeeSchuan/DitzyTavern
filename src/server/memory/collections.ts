import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Value } from "@sinclair/typebox/value";
import { readActiveVariantIds, readConversationRevision, readMessageAuthorsForMemory, readMemoryTailMessageId, readSelectedPathForMemory, readVariantsForMemory, type MemorySourceVariant } from "../conversation";
import { conversationMemorySettingsTable, memoryCatchupRunTable, memoryCollectionTable } from "../database/schema";
import type { MemoryTrace } from "./extraction";
import {
	claimMemoryIndexJob,
	embedMemoryTexts,
	readMemoryEmbeddingConfiguration,
	readMemoryIndexReadiness,
	readMemoryIndexReadinessBatch,
	runMemoryIndexJob,
	type MemoryEmbed,
} from "./indexing";
import { isMemoryEnabledForConversation } from "./settings";
import {
	memoryCandidates,
	memoryTraceSteps,
	memoryWorkSnapshot,
	type CapturedMemoryMessage,
	type MemoryCandidateJudgment,
	type MemoryCatchup,
	type MemoryCollectionView,
	type MemoryCorrectionCommand,
} from "../../shared/contract/memory";
import type { MemoryIndexReadiness, MemoryTraceStep } from "../../shared/contract/memory";
import { abortMemoryWork, indexingVariants, registerMemoryWork, registeredMemoryVariants } from "./work";
import { sha256 } from "./hash";
import { projectImageAnchors } from "../../shared/image-reference";
import { applyMemoryLabelRules, isExcludedMemorySource, readMemoryLabelState, type MemoryLabelState } from "./labels";
import { hasValidMemoryClaimText, hasValidMemoryPeople } from "./claim-validation";

export class StaleMemoryCollectionError extends Error {
	readonly outcome = "conflict" as const;
	readonly details;

	constructor(readonly collection: MemoryCollectionView) {
		super("This Memory collection changed in another session.");
		this.name = "StaleMemoryCollectionError";
		this.details = { collection };
	}
}

export class InvalidMemorySourceError extends Error {
	readonly outcome = "invalid" as const;
	readonly details = { reason: this.message };

	constructor(message: string) {
		super(message);
		this.name = "InvalidMemorySourceError";
	}
}

type CollectionRow = typeof memoryCollectionTable.$inferSelect;
type SourceVariant = Omit<CapturedMemoryMessage, "speaker"> & { selected: boolean };
type CapturedMemorySource = { source: CapturedMemoryMessage; context: readonly CapturedMemoryMessage[]; sourceHash: string };

const captured = (source: CapturedMemoryMessage, context: readonly CapturedMemoryMessage[]): CapturedMemorySource => {
	if (source.content.trim().length === 0) throw new InvalidMemorySourceError("Empty sources are not processed. Save nonempty story content first.");
	const anchored = (message: CapturedMemoryMessage): CapturedMemoryMessage => ({ ...message, content: projectImageAnchors(message.content) });
	return { source: anchored(source), context: context.map(anchored), sourceHash: sha256(source.content) };
};

const capture = (database: Database, conversationId: number, messageId: number): CapturedMemorySource => {
	const path = readSelectedPathForMemory(database, conversationId, messageId) ?? [];
	const current = path.find((message) => message.messageId === messageId);
	const source = current?.variant;
	if (!source) throw new InvalidMemorySourceError("Memory can only process a retained selected Variant.");
	if (source.active) throw new InvalidMemorySourceError("A provisional Generation is not eligible for Memory yet.");
	const previous = path.filter((message) => message.position < source.position && message.variant !== null).slice(-4)
		.map((message) => ({ messageId: message.messageId, variantId: message.variant!.variantId, speaker: message.author, content: message.variant!.content }));
	return captured({ messageId, variantId: source.variantId, speaker: source.speaker, content: source.content }, previous);
};

const parseClaims = (claimsJson: string): MemoryCandidateJudgment[] | null => {
	try { return Value.Parse(memoryCandidates, JSON.parse(claimsJson)); } catch { return null; }
};

const toView = (row: CollectionRow, variant: SourceVariant, indexing: MemoryIndexReadiness): MemoryCollectionView => {
	const sourceChanged = row.source_changed || sha256(variant.content) !== row.source_hash;
	const staleError = row.ownership === "writer"
		? "This source changed. Automatic updates are paused for this writer-maintained collection."
		: row.error ?? "This source changed after its Memory collection was created.";
	return {
		messageId: variant.messageId,
		variantId: variant.variantId,
		selected: variant.selected,
		status: sourceChanged ? "stale" : row.status,
		error: sourceChanged ? staleError : row.error,
		revision: row.revision,
		ownership: row.ownership,
		sourceChanged,
		claims: sourceChanged && row.ownership === "automatic" ? [] : parseClaims(row.claims_json) ?? [],
		indexing,
	};
};

const unprocessedView = (variant: SourceVariant, enabled: boolean): MemoryCollectionView => ({
	messageId: variant.messageId,
	variantId: variant.variantId,
	selected: variant.selected,
	status: "unprocessed",
	error: null,
	revision: 0,
	ownership: "automatic",
	sourceChanged: false,
	claims: [],
	indexing: { status: enabled ? "not-applicable" : "disabled", pendingCount: 0, error: null },
});

const readSourceVariant = (database: Database, conversationId: number, messageId: number, variantId: number): SourceVariant | undefined =>
	readVariantsForMemory(database, conversationId, { variantIds: [variantId], includeActive: true }).find((variant) => variant.messageId === messageId);

const readCollection = (database: Database, variantId: number) =>
	drizzle(database).select().from(memoryCollectionTable).where(eq(memoryCollectionTable.variant_id, variantId)).get();

const writeQueuedCollection = (database: Database, conversationId: number, messageId: number, source: CapturedMemorySource, catchupRunId: number | null, current: CollectionRow | undefined) => {
	const values: typeof memoryCollectionTable.$inferInsert = {
		variant_id: source.source.variantId,
		conversation_id: conversationId,
		message_id: messageId,
		source_hash: source.sourceHash,
		revision: (current?.revision ?? 0) + 1,
		ownership: "automatic",
		work_epoch: (current?.work_epoch ?? 0) + 1,
		status: "pending",
		error: null,
		source_snapshot_json: JSON.stringify({ source: source.source, context: source.context }),
		claims_json: "[]",
		trace_json: null,
		catchup_run_id: catchupRunId,
		source_changed: false,
		index_attempt_json: null,
		updated_at: new Date().toISOString(),
	};
	const row = drizzle(database)
		.insert(memoryCollectionTable)
		.values(values)
		.onConflictDoUpdate({ target: memoryCollectionTable.variant_id, set: values })
		.returning()
		.get();
	abortMemoryWork(database, [source.source.variantId]);
	return row;
};

// @approved
//  Queue one explicit replacement using only its selected Variant and four prior selected Messages.
export function resetAndReextractMemorySource(database: Database, conversationId: number, messageId: number, variantId: number, expectedRevision: number): MemoryCollectionView {
	return database.transaction(() => {
		const enabled = isMemoryEnabledForConversation(database, conversationId);
		if (!enabled) throw new InvalidMemorySourceError("Turn on Memory and enable it in the selected Prompt Preset before remembering a source.");
		if (isExcludedMemorySource(database, conversationId, messageId)) throw new InvalidMemorySourceError("This author's Messages are not Memory sources.");
		const variant = readSourceVariant(database, conversationId, messageId, variantId);
		if (!variant) throw new InvalidMemorySourceError("This source no longer exists.");
		const current = readCollection(database, variantId);
		if (!variant.selected || (current?.revision ?? 0) !== expectedRevision) {
			if (current) throw new StaleMemoryCollectionError(toView(current, variant, readMemoryIndexReadiness(database, current, enabled)));
			if (!variant.selected || variant.content.trim().length === 0) throw new InvalidMemorySourceError("This source is no longer available for extraction.");
			throw new StaleMemoryCollectionError(unprocessedView(variant, enabled));
		}
		const row = writeQueuedCollection(database, conversationId, messageId, capture(database, conversationId, messageId), null, current);
		return toView(row, variant, readMemoryIndexReadiness(database, row, enabled));
	}).immediate();
}

// @approved
//  Queue selected source work from an authoritative write transaction.
export function queueMemorySource(database: Database, conversationId: number, messageId: number, catchupRunId: number | null = null, knownCapture?: CapturedMemorySource): boolean {
	if (!isMemoryEnabledForConversation(database, conversationId) || isExcludedMemorySource(database, conversationId, messageId)) return false;
	let source: CapturedMemorySource;
	try { source = knownCapture ?? capture(database, conversationId, messageId); } catch { return false; }
	const current = readCollection(database, source.source.variantId);
	if (current?.ownership === "writer") return false;
	if (current && current.source_hash === source.sourceHash && (current.status === "pending" || current.status === "running")) {
		if (current.catchup_run_id !== null && current.catchup_run_id !== catchupRunId) {
			drizzle(database)
				.update(memoryCollectionTable)
				.set({ catchup_run_id: catchupRunId, updated_at: new Date().toISOString() })
				.where(eq(memoryCollectionTable.variant_id, current.variant_id))
				.run();
		}
		return false;
	}
	if (current && current.source_hash === source.sourceHash && current.status === "complete") return false;
	writeQueuedCollection(database, conversationId, messageId, source, catchupRunId, current);
	return true;
}

export function queueMemoryTail(database: Database, conversationId: number): boolean {
	const messageId = readMemoryTailMessageId(database, conversationId);
	return messageId === undefined ? false : queueMemorySource(database, conversationId, messageId);
}

// @approved
//  Queue selected source work from an authoritative write transaction.
// The selected history arrives through a reader the caller owns (the Memory
// route composes it from Conversation's own read model), invoked inside this
// transaction so the path snapshot is consistent with the queued work.
export function startMemoryCatchup(database: Database, conversationId: number, readSources: () => readonly CapturedMemoryMessage[] | undefined): MemoryCatchup {
	return database.transaction(() => {
		if (!isMemoryEnabledForConversation(database, conversationId)) throw new InvalidMemorySourceError("Turn on Memory and enable it in the selected Prompt Preset before remembering history.");
		const sources = readSources();
		if (!sources) throw new InvalidMemorySourceError("This Chat no longer exists.");
		const run = drizzle(database)
			.insert(memoryCatchupRunTable)
			.values({ conversation_id: conversationId, created_at: new Date().toISOString() })
			.returning()
			.get();
		const activeVariants = readActiveVariantIds(database, conversationId);
		const previous: CapturedMemoryMessage[] = [];
		for (const source of sources) {
			if (source.content.trim().length > 0 && !activeVariants.has(source.variantId)) {
				queueMemorySource(database, conversationId, source.messageId, run.id, captured(source, [...previous]));
			}
			previous.push(source);
			if (previous.length > 4) previous.shift();
		}
		return readMemoryCatchup(database, run);
	}).immediate();
}

const readMemoryCatchup = (database: Database, run: typeof memoryCatchupRunTable.$inferSelect): MemoryCatchup => {
	const jobs = drizzle(database)
		.select({ status: memoryCollectionTable.status, messageId: memoryCollectionTable.message_id, error: memoryCollectionTable.error })
		.from(memoryCollectionTable)
		.where(eq(memoryCollectionTable.catchup_run_id, run.id))
		.all();
	const count = (status: CollectionRow["status"]) => jobs.filter((job) => job.status === status).length;
	const failed = jobs.filter((job) => job.status === "failed").map(({ messageId, error }) => ({ messageId, error }));
	const pending = count("pending");
	const running = count("running");
	const state = run.cancelled ? "cancelled" : pending + running > 0 ? "running" : failed.length > 0 ? "failed" : "complete";
	return { id: run.id, state, pending, running, complete: count("complete"), failed };
};

export function readLatestMemoryCatchup(database: Database, conversationId: number): MemoryCatchup | null {
	const run = drizzle(database)
		.select()
		.from(memoryCatchupRunTable)
		.where(eq(memoryCatchupRunTable.conversation_id, conversationId))
		.orderBy(desc(memoryCatchupRunTable.id))
		.get();
	return run ? readMemoryCatchup(database, run) : null;
}

export function cancelMemoryCatchup(database: Database, conversationId: number, runId: number): MemoryCatchup {
	return database.transaction(() => {
		const db = drizzle(database);
		const run = db
			.select()
			.from(memoryCatchupRunTable)
			.where(and(eq(memoryCatchupRunTable.id, runId), eq(memoryCatchupRunTable.conversation_id, conversationId)))
			.get();
		if (!run || run.cancelled) throw new InvalidMemorySourceError("This history catch-up run is no longer active.");
		const current = readMemoryCatchup(database, run);
		if (current.pending + current.running === 0 && (current.complete > 0 || current.failed.length > 0)) {
			throw new InvalidMemorySourceError("This history catch-up run is already finished.");
		}
		db.delete(memoryCollectionTable)
			.where(and(eq(memoryCollectionTable.catchup_run_id, runId), eq(memoryCollectionTable.status, "pending")))
			.run();
		const superseded = db
			.update(memoryCollectionTable)
			.set({
				work_epoch: sql`${memoryCollectionTable.work_epoch} + 1`,
				status: "failed",
				error: "History catch-up was cancelled.",
				catchup_run_id: null,
				updated_at: new Date().toISOString(),
			})
			.where(and(eq(memoryCollectionTable.catchup_run_id, runId), eq(memoryCollectionTable.status, "running")))
			.returning({ id: memoryCollectionTable.variant_id })
			.all();
		abortMemoryWork(database, superseded.map(({ id }) => id));
		const cancelled = db.update(memoryCatchupRunTable).set({ cancelled: true }).where(eq(memoryCatchupRunTable.id, runId)).returning().get()!;
		return readMemoryCatchup(database, cancelled);
	}).immediate();
}

interface MemoryCollectionSource {
	variant: MemorySourceVariant;
	collection: CollectionRow | undefined;
}

const memoryViews = (database: Database, conversationId: number, rows: MemoryCollectionSource[], state: MemoryLabelState, configuration = readMemoryEmbeddingConfiguration(database)): MemoryCollectionView[] => {
	const enabled = isMemoryEnabledForConversation(database, conversationId);
	const readiness = readMemoryIndexReadinessBatch(database, rows.flatMap(({ collection }) => collection ? [collection] : []), enabled, configuration);
	return rows.flatMap(({ variant, collection }) => {
		if (variant.authorParticipantId !== null && state.identities[variant.authorParticipantId]?.kind === "excluded") return [];
		if (collection) return [toView(collection, variant, readiness.get(variant.variantId)!)];
		return variant.content.trim().length === 0 ? [] : [unprocessedView(variant, enabled)];
	});
};

const collectionSources = (database: Database, conversationId: number, collections: CollectionRow[], changes = false): MemoryCollectionSource[] => {
	const byVariant = new Map(collections.map((collection) => [collection.variant_id, collection]));
	const keys = [...byVariant.keys()];
	return readVariantsForMemory(database, conversationId, changes ? { variantIds: keys, includeActive: true } : { selectedOrVariantIds: keys })
		.sort((left, right) => Number(right.selected) - Number(left.selected) || left.position - right.position || left.variantPosition - right.variantPosition)
		.map((variant) => ({ variant, collection: byVariant.get(variant.variantId) }));
};

export function readConversationMemories(database: Database, conversationId: number) {
	const cursor = new Date().toISOString();
	const state = readMemoryLabelState(database, conversationId);
	const path = readMessageAuthorsForMemory(database, conversationId);
	const collections = drizzle(database).select().from(memoryCollectionTable).where(eq(memoryCollectionTable.conversation_id, conversationId)).all();
	return {
		revision: readConversationRevision(database, conversationId) ?? 0,
		cursor,
		sources: memoryViews(database, conversationId, collectionSources(database, conversationId, collections), state),
		path,
		identities: state.identities,
		cast: state.cast,
		labelMerges: state.merges,
		labelRevision: state.revision,
	};
}

export function readConversationMemoryChanges(database: Database, conversationId: number, since: string) {
	const cursor = new Date().toISOString();
	const configuration = readMemoryEmbeddingConfiguration(database);
	const running = [...new Set([...registeredMemoryVariants(database), ...indexingVariants(database, configuration.spaceKey)])];
	const collections = drizzle(database).select().from(memoryCollectionTable).where(and(
		eq(memoryCollectionTable.conversation_id, conversationId),
		or(gte(memoryCollectionTable.updated_at, since), sql`json_extract(${memoryCollectionTable.index_attempt_json}, '$.error') IS NOT NULL`, running.length === 0 ? undefined : inArray(memoryCollectionTable.variant_id, running)),
	)).all();
	const state = readMemoryLabelState(database, conversationId);
	return { cursor, revision: readConversationRevision(database, conversationId) ?? 0, labelRevision: state.revision, sources: memoryViews(database, conversationId, collectionSources(database, conversationId, collections, true), state, configuration) };
}

export function correctMemorySource(database: Database, conversationId: number, command: MemoryCorrectionCommand): MemoryCollectionView {
	const { messageId, variantId, expectedRevision, index } = command;
	return database.transaction(() => {
		const variant = readSourceVariant(database, conversationId, messageId, variantId);
		if (!variant) throw new InvalidMemorySourceError("This source no longer exists.");
		const row = readCollection(database, variantId);
		if (!row) throw new InvalidMemorySourceError("This source has no saved Memory collection to correct.");
		const enabled = isMemoryEnabledForConversation(database, conversationId);
		if (row.revision !== expectedRevision) throw new StaleMemoryCollectionError(toView(row, variant, readMemoryIndexReadiness(database, row, enabled)));
		const claims = parseClaims(row.claims_json);
		if (!claims) throw new InvalidMemorySourceError("This Memory collection cannot be edited because its saved content is invalid.");
		if (!Number.isSafeInteger(index) || index < 0 || index >= claims.length) throw new InvalidMemorySourceError("This Memory no longer exists in the source collection.");
		if (command.operation === "edit") {
			if (!hasValidMemoryClaimText(command.claim, command.attribution) || !hasValidMemoryPeople(command.people)) {
				throw new InvalidMemorySourceError("Memory text, attribution, or person labels are invalid.");
			}
			claims[index] = { ...claims[index]!, claim: command.claim, attribution: command.attribution, people: command.people, writerMaintained: true };
		} else {
			claims.splice(index, 1);
		}
		const updated = drizzle(database)
			.update(memoryCollectionTable)
			.set({
				revision: row.revision + 1,
				ownership: "writer",
				status: "complete",
				error: null,
				claims_json: JSON.stringify(applyMemoryLabelRules(claims, readMemoryLabelState(database, conversationId))),
				work_epoch: row.work_epoch + 1,
				index_attempt_json: null,
				updated_at: new Date().toISOString(),
			})
			.where(eq(memoryCollectionTable.variant_id, variantId))
			.returning()
			.get()!;
		abortMemoryWork(database, [variantId]);
		return toView(updated, variant, readMemoryIndexReadiness(database, updated, enabled));
	}).immediate();
}

export function retryMemorySourceIndex(database: Database, conversationId: number, messageId: number, variantId: number, expectedRevision: number): MemoryCollectionView {
	return database.transaction(() => {
		const variant = readSourceVariant(database, conversationId, messageId, variantId);
		const row = readCollection(database, variantId);
		if (!variant || !row) throw new InvalidMemorySourceError("This source has no saved Memory collection to index.");
		const enabled = isMemoryEnabledForConversation(database, conversationId);
		if (row.revision !== expectedRevision) throw new StaleMemoryCollectionError(toView(row, variant, readMemoryIndexReadiness(database, row, enabled)));
		if (row.status !== "complete") throw new InvalidMemorySourceError("Indexing requires a completed saved Memory collection.");
		if (!enabled) throw new InvalidMemorySourceError("Turn on Memory and enable it in the selected Prompt Preset before indexing saved Memories.");
		const updated = drizzle(database)
			.update(memoryCollectionTable)
			.set({ index_attempt_json: null, updated_at: new Date().toISOString() })
			.where(eq(memoryCollectionTable.variant_id, variantId))
			.returning()
			.get()!;
		return toView(updated, variant, readMemoryIndexReadiness(database, updated, enabled));
	}).immediate();
}

export class StaleMemorySettingsError extends Error {
	readonly outcome = "conflict" as const;
	readonly details;

	constructor(
		readonly expectedRevision: number,
		readonly actualRevision: number,
		readonly currentSettings: { revision: number; allowance: number; note: string; enabled: boolean },
	) {
		super("Memory settings changed in another session.");
		this.name = "StaleMemorySettingsError";
		this.details = { expectedRevision, actualRevision, currentSettings };
	}
}

// @approved
//  Invalidate one source version whenever its text or selected status changes.
export function invalidateMemoryWorkForVariant(database: Database, variantId: number) {
	const row = readCollection(database, variantId);
	if (!row) return;
	const failed = row.ownership === "automatic"
		? { status: "failed" as const, error: "This source changed after its Memory collection was created. Reset and re-extract it to create a collection for the current source version." }
		: {};
	drizzle(database)
		.update(memoryCollectionTable)
		.set({ work_epoch: row.work_epoch + 1, source_changed: true, updated_at: new Date().toISOString(), ...failed })
		.where(eq(memoryCollectionTable.variant_id, variantId))
		.run();
	abortMemoryWork(database, [variantId]);
}

const ensureChatState = (database: Database, conversationId: number) => {
	const db = drizzle(database);
	db.insert(conversationMemorySettingsTable).values({ conversation_id: conversationId }).onConflictDoNothing().run();
	const state = db.select().from(conversationMemorySettingsTable).where(eq(conversationMemorySettingsTable.conversation_id, conversationId)).get();
	if (!state) throw new InvalidMemorySourceError("This Chat no longer exists.");
	return state;
};

const memorySettingsView = (database: Database, conversationId: number, state: typeof conversationMemorySettingsTable.$inferSelect) => ({
	revision: state.revision, allowance: state.allowance, note: state.memory_note, enabled: isMemoryEnabledForConversation(database, conversationId),
});

export function readMemoryAllowance(database: Database, conversationId: number) {
	return memorySettingsView(database, conversationId, ensureChatState(database, conversationId));
}

export function setMemoryAllowance(database: Database, conversationId: number, expectedRevision: number, allowance: number) {
	if (!Number.isSafeInteger(allowance) || allowance < 0) {
		throw new InvalidMemorySourceError("Memory Allowance must be a non-negative whole number of estimated tokens.");
	}
	return database.transaction(() => {
		const current = ensureChatState(database, conversationId);
		if (current.revision !== expectedRevision) throw new StaleMemorySettingsError(expectedRevision, current.revision, memorySettingsView(database, conversationId, current));
		const next = current.revision + 1;
		drizzle(database)
			.update(conversationMemorySettingsTable)
			.set({ allowance, revision: next })
			.where(eq(conversationMemorySettingsTable.conversation_id, conversationId))
			.run();
		return memorySettingsView(database, conversationId, { ...current, allowance, revision: next });
	}).immediate();
}

export function setMemoryNote(database: Database, conversationId: number, expectedRevision: number, note: string) {
	const memoryNote = note.trim();
	if (memoryNote.length > 2_000) throw new InvalidMemorySourceError("The Memory note is limited to 2,000 characters.");
	return database.transaction(() => {
		const current = ensureChatState(database, conversationId);
		if (current.revision !== expectedRevision) throw new StaleMemorySettingsError(expectedRevision, current.revision, memorySettingsView(database, conversationId, current));
		const next = current.revision + 1;
		drizzle(database)
			.update(conversationMemorySettingsTable)
			.set({ memory_note: memoryNote, revision: next })
			.where(eq(conversationMemorySettingsTable.conversation_id, conversationId))
			.run();
		return memorySettingsView(database, conversationId, { ...current, memory_note: memoryNote, revision: next });
	}).immediate();
}

export interface MemoryWorkerOptions {
	process: (source: CapturedMemoryMessage, context: readonly CapturedMemoryMessage[], signal: AbortSignal, trace: MemoryTrace) => Promise<MemoryCandidateJudgment[]>;
	embed?: MemoryEmbed;
	concurrency?: number;
}

const claimNextMemoryJob = (database: Database) => database.transaction(() => {
	const db = drizzle(database);
	const extraction = db
		.select()
		.from(memoryCollectionTable)
		.where(and(eq(memoryCollectionTable.status, "pending"), eq(memoryCollectionTable.ownership, "automatic")))
		.orderBy(asc(memoryCollectionTable.catchup_run_id), asc(memoryCollectionTable.updated_at))
		.get();
	// @approved
	//  Live (non-catch-up) extraction outranks indexing; indexing runs only when no live extraction is waiting.
	const liveExtractionPending = extraction !== undefined && extraction.catchup_run_id === null;
	const index = liveExtractionPending ? undefined : claimMemoryIndexJob(database);
	if (index) return { kind: "index" as const, job: index };
	if (!extraction) return undefined;
	db.update(memoryCollectionTable)
		.set({ status: "running", updated_at: new Date().toISOString() })
		.where(eq(memoryCollectionTable.variant_id, extraction.variant_id))
		.run();
	return { kind: "extract" as const, job: extraction };
}).immediate();

const runMemoryExtraction = async (database: Database, job: CollectionRow, process: MemoryWorkerOptions["process"], shutdown: AbortSignal) => {
	const db = drizzle(database);
	const current = and(
		eq(memoryCollectionTable.variant_id, job.variant_id),
		eq(memoryCollectionTable.work_epoch, job.work_epoch),
		eq(memoryCollectionTable.status, "running"),
	);
	if (job.catchup_run_id !== null) {
		const selected = readVariantsForMemory(database, job.conversation_id, { variantIds: [job.variant_id], includeActive: true })[0];
		if (selected?.selected !== true) {
			db.delete(memoryCollectionTable).where(current).run();
			return;
		}
	}
	const { signal, unregister } = registerMemoryWork(database, job.variant_id);
	const steps: MemoryTraceStep[] = [];
	const trace: MemoryTrace = (label, fields) => {
		if (signal.aborted || shutdown.aborted) return;
		steps.push({ label, at: new Date().toISOString(), fields });
		db.update(memoryCollectionTable)
			.set({ trace_json: JSON.stringify(steps), updated_at: new Date().toISOString() })
			.where(and(eq(memoryCollectionTable.variant_id, job.variant_id), eq(memoryCollectionTable.work_epoch, job.work_epoch)))
			.run();
	};
	try {
		const snapshot = Value.Parse(memoryWorkSnapshot, JSON.parse(job.source_snapshot_json));
		const claims = await process(snapshot.source, snapshot.context, AbortSignal.any([shutdown, signal]), trace);
		signal.throwIfAborted();
		database.transaction(() => {
			const merged = applyMemoryLabelRules(claims, readMemoryLabelState(database, job.conversation_id));
			db.update(memoryCollectionTable)
				.set({ status: "complete", claims_json: JSON.stringify(merged), error: null, index_attempt_json: null, updated_at: new Date().toISOString() })
				.where(current)
				.run();
		}).immediate();
	} catch (error) {
		if (shutdown.aborted) return;
		if (signal.aborted) return;
		const message = error instanceof Error ? error.message.slice(0, 1024) : "Memory extraction failed.";
		trace("Failed", { error: message });
		db.update(memoryCollectionTable)
			.set({ status: "failed", error: message, updated_at: new Date().toISOString() })
			.where(current)
			.run();
	} finally {
		unregister();
	}
};

export function startMemoryWorker(database: Database, options: MemoryWorkerOptions) {
	const shutdown = new AbortController();
	const embed = options.embed ?? embedMemoryTexts(database);
	const loop = async () => {
		while (!shutdown.signal.aborted) {
			const next = claimNextMemoryJob(database);
			if (!next) await new Promise((resolve) => setTimeout(resolve, 300));
			else if (next.kind === "extract") await runMemoryExtraction(database, next.job, options.process, shutdown.signal);
			else await runMemoryIndexJob(database, next.job, embed, shutdown.signal);
		}
	};
	drizzle(database)
		.update(memoryCollectionTable)
		.set({ status: "pending", updated_at: new Date().toISOString() })
		.where(and(eq(memoryCollectionTable.status, "running"), eq(memoryCollectionTable.ownership, "automatic")))
		.run();
	const workers = Array.from({ length: Math.min(2, Math.max(1, options.concurrency ?? 2)) }, loop);
	return async () => {
		shutdown.abort();
		await Promise.all(workers);
	};
}

export function readMemoryTrace(database: Database, conversationId: number, variantId: number): MemoryTraceStep[] {
	const row = drizzle(database)
		.select({ trace: memoryCollectionTable.trace_json })
		.from(memoryCollectionTable)
		.where(and(eq(memoryCollectionTable.variant_id, variantId), eq(memoryCollectionTable.conversation_id, conversationId)))
		.get();
	return row?.trace ? Value.Parse(memoryTraceSteps, JSON.parse(row.trace)) : [];
}
