import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Value } from "@sinclair/typebox/value";
import { readSelectedHistory } from "../conversation/selected-history";
import { activeGenerationTable, conversationMemorySettingsTable, memoryCatchupRunTable, memoryCollectionTable, messageTable, messageVariantTable } from "../database/schema";
import type { MemoryTrace } from "./extraction";
import { claimMemoryIndexJob, embedMemoryTexts, readMemoryIndexReadiness, readMemoryIndexReadinessBatch, runMemoryIndexJob, type MemoryEmbed } from "./indexing";
import { isMemoryEnabledForConversation } from "./settings";
import { memoryCandidates, memoryTraceSteps, memoryWorkSnapshot, type CapturedMemoryMessage, type MemoryCandidateJudgment, type MemoryCatchup, type MemoryCollectionView, type MemoryCorrectionCommand, type MemoryIndexReadiness, type MemoryTraceStep } from "../../shared/contract/memory";
import { abortMemoryWork, registerMemoryWork } from "./work";
import { sha256 } from "./hash";
import { projectImageAnchors } from "../../shared/image-reference";
import { applyMemoryLabelRules, isExcludedMemorySource, readMemoryLabelState } from "./labels";
import { hasValidMemoryClaimText, hasValidMemoryPeople } from "./claim-validation";

export class StaleMemoryCollectionError extends Error {
	constructor(readonly collection: MemoryCollectionView) { super("This Memory collection changed in another session."); this.name = "StaleMemoryCollectionError"; }
}

export class InvalidMemorySourceError extends Error {
	constructor(message: string) { super(message); this.name = "InvalidMemorySourceError"; }
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
	const source = database.query<{ position: number; variant_id: number; speaker: string | null; content: string }, [number, number]>("SELECT m.position, m.author_name AS speaker, v.id AS variant_id, v.content FROM messages m JOIN message_variant v ON v.message_id=m.id AND v.selected=1 WHERE m.conversation_id=? AND m.id=?").get(conversationId, messageId);
	if (!source) throw new InvalidMemorySourceError("Memory can only process a retained selected Variant.");
	if (database.query<{ id: number }, [number]>("SELECT id FROM active_generation WHERE variant_id=?").get(source.variant_id)) throw new InvalidMemorySourceError("A provisional Generation is not eligible for Memory yet.");
	const previous = database.query<CapturedMemoryMessage, [number, number]>("SELECT m.id AS messageId, v.id AS variantId, m.author_name AS speaker, v.content FROM messages m JOIN message_variant v ON v.message_id=m.id AND v.selected=1 WHERE m.conversation_id=? AND m.position<? ORDER BY m.position DESC LIMIT 4").all(conversationId, source.position).reverse();
	return captured({ messageId, variantId: source.variant_id, speaker: source.speaker, content: source.content }, previous);
};

const parseClaims = (claimsJson: string): MemoryCandidateJudgment[] | null => {
	try { return Value.Parse(memoryCandidates, JSON.parse(claimsJson)); } catch { return null; }
};

const toView = (row: CollectionRow, variant: SourceVariant, indexing: MemoryIndexReadiness): MemoryCollectionView => {
	const sourceChanged = row.source_changed || sha256(variant.content) !== row.source_hash;
	const staleError = row.ownership === "writer" ? "This source changed. Automatic updates are paused for this writer-maintained collection." : row.error ?? "This source changed after its Memory collection was created.";
	return {
		messageId: variant.messageId, variantId: variant.variantId, selected: variant.selected,
		status: sourceChanged ? "stale" : row.status, error: sourceChanged ? staleError : row.error,
		revision: row.revision, ownership: row.ownership, sourceChanged,
		claims: sourceChanged && row.ownership === "automatic" ? [] : parseClaims(row.claims_json) ?? [], indexing,
	};
};

const unprocessedView = (variant: SourceVariant, enabled: boolean): MemoryCollectionView => ({
	...variant, status: "unprocessed", error: null, revision: 0, ownership: "automatic", sourceChanged: false, claims: [],
	indexing: { status: enabled ? "not-applicable" : "disabled", pendingCount: 0, error: null },
});

const readSourceVariant = (database: Database, conversationId: number, messageId: number, variantId: number): SourceVariant | undefined =>
	drizzle(database).select({ messageId: messageTable.id, variantId: messageVariantTable.id, selected: messageVariantTable.selected, content: messageVariantTable.content }).from(messageVariantTable).innerJoin(messageTable, eq(messageTable.id, messageVariantTable.message_id)).where(and(eq(messageVariantTable.id, variantId), eq(messageTable.id, messageId), eq(messageTable.conversation_id, conversationId))).get();

const readCollection = (database: Database, variantId: number) => drizzle(database).select().from(memoryCollectionTable).where(eq(memoryCollectionTable.variant_id, variantId)).get();

const writeQueuedCollection = (database: Database, conversationId: number, messageId: number, source: CapturedMemorySource, catchupRunId: number | null, current: CollectionRow | undefined) => {
	const values: typeof memoryCollectionTable.$inferInsert = {
		variant_id: source.source.variantId, conversation_id: conversationId, message_id: messageId,
		source_hash: source.sourceHash, revision: (current?.revision ?? 0) + 1, ownership: "automatic", work_epoch: (current?.work_epoch ?? 0) + 1,
		status: "pending", error: null, source_snapshot_json: JSON.stringify({ source: source.source, context: source.context }),
		claims_json: "[]", trace_json: null, catchup_run_id: catchupRunId, source_changed: false, index_attempt_json: null, updated_at: new Date().toISOString(),
	};
	const row = drizzle(database).insert(memoryCollectionTable).values(values).onConflictDoUpdate({ target: memoryCollectionTable.variant_id, set: values }).returning().get();
	abortMemoryWork(database, [source.source.variantId]);
	return row;
};

// ==[HUMAN APPROVED]== Queue one explicit replacement using only its selected Variant and four prior selected Messages.
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

// ==[HUMAN APPROVED]== Queue selected source work from an authoritative write transaction.
export function queueMemorySource(database: Database, conversationId: number, messageId: number, catchupRunId: number | null = null, knownCapture?: CapturedMemorySource): boolean {
	if (!isMemoryEnabledForConversation(database, conversationId) || isExcludedMemorySource(database, conversationId, messageId)) return false;
	let source: CapturedMemorySource;
	try { source = knownCapture ?? capture(database, conversationId, messageId); } catch { return false; }
	const current = readCollection(database, source.source.variantId);
	if (current?.ownership === "writer") return false;
	if (current && current.source_hash === source.sourceHash && (current.status === "pending" || current.status === "running")) {
		if (current.catchup_run_id !== null && current.catchup_run_id !== catchupRunId) drizzle(database).update(memoryCollectionTable).set({ catchup_run_id: catchupRunId, updated_at: new Date().toISOString() }).where(eq(memoryCollectionTable.variant_id, current.variant_id)).run();
		return false;
	}
	if (current && current.source_hash === source.sourceHash && current.status === "complete") return false;
	writeQueuedCollection(database, conversationId, messageId, source, catchupRunId, current);
	return true;
}

export function queueMemoryTail(database: Database, conversationId: number): boolean {
	const tail = database.query<{ id: number }, [number]>("SELECT id FROM messages WHERE conversation_id = ? ORDER BY position DESC LIMIT 1").get(conversationId);
	return tail ? queueMemorySource(database, conversationId, tail.id) : false;
}

export function startMemoryCatchup(database: Database, conversationId: number): MemoryCatchup {
	return database.transaction(() => {
		if (!isMemoryEnabledForConversation(database, conversationId)) throw new InvalidMemorySourceError("Turn on Memory and enable it in the selected Prompt Preset before remembering history.");
		const history = readSelectedHistory(database, conversationId);
		if (!history) throw new InvalidMemorySourceError("This Chat no longer exists.");
		const run = drizzle(database).insert(memoryCatchupRunTable).values({ conversation_id: conversationId, created_at: new Date().toISOString() }).returning().get();
		const activeVariants = new Set(drizzle(database).select({ id: activeGenerationTable.variant_id }).from(activeGenerationTable).where(eq(activeGenerationTable.conversation_id, conversationId)).all().map(({ id }) => id));
		const previous: CapturedMemoryMessage[] = [];
		for (const message of history.messages) {
			if (!message.variant) continue;
			const source = { messageId: message.id, variantId: message.variant.id, speaker: message.author?.capturedName ?? null, content: message.variant.content };
			if (source.content.trim().length > 0 && !activeVariants.has(source.variantId)) queueMemorySource(database, conversationId, message.id, run.id, captured(source, [...previous]));
			previous.push(source);
			if (previous.length > 4) previous.shift();
		}
		return readMemoryCatchup(database, run);
	}).immediate();
}

const readMemoryCatchup = (database: Database, run: typeof memoryCatchupRunTable.$inferSelect): MemoryCatchup => {
	const jobs = drizzle(database).select({ status: memoryCollectionTable.status, messageId: memoryCollectionTable.message_id, error: memoryCollectionTable.error }).from(memoryCollectionTable).where(eq(memoryCollectionTable.catchup_run_id, run.id)).all();
	const count = (status: CollectionRow["status"]) => jobs.filter((job) => job.status === status).length;
	const failed = jobs.filter((job) => job.status === "failed").map(({ messageId, error }) => ({ messageId, error }));
	const pending = count("pending");
	const running = count("running");
	const state = run.cancelled ? "cancelled" : pending + running > 0 ? "running" : failed.length > 0 ? "failed" : "complete";
	return { id: run.id, state, pending, running, complete: count("complete"), failed };
};

export function readLatestMemoryCatchup(database: Database, conversationId: number): MemoryCatchup | null {
	const run = drizzle(database).select().from(memoryCatchupRunTable).where(eq(memoryCatchupRunTable.conversation_id, conversationId)).orderBy(desc(memoryCatchupRunTable.id)).get();
	return run ? readMemoryCatchup(database, run) : null;
}

export function cancelMemoryCatchup(database: Database, conversationId: number, runId: number): MemoryCatchup {
	return database.transaction(() => {
		const db = drizzle(database);
		const run = db.select().from(memoryCatchupRunTable).where(and(eq(memoryCatchupRunTable.id, runId), eq(memoryCatchupRunTable.conversation_id, conversationId))).get();
		if (!run || run.cancelled) throw new InvalidMemorySourceError("This history catch-up run is no longer active.");
		const current = readMemoryCatchup(database, run);
		if (current.pending + current.running === 0 && (current.complete > 0 || current.failed.length > 0)) throw new InvalidMemorySourceError("This history catch-up run is already finished.");
		db.delete(memoryCollectionTable).where(and(eq(memoryCollectionTable.catchup_run_id, runId), eq(memoryCollectionTable.status, "pending"))).run();
		const superseded = db.update(memoryCollectionTable).set({ work_epoch: sql`${memoryCollectionTable.work_epoch} + 1`, status: "failed", error: "History catch-up was cancelled.", catchup_run_id: null, updated_at: new Date().toISOString() })
			.where(and(eq(memoryCollectionTable.catchup_run_id, runId), eq(memoryCollectionTable.status, "running"))).returning({ id: memoryCollectionTable.variant_id }).all();
		abortMemoryWork(database, superseded.map(({ id }) => id));
		return readMemoryCatchup(database, db.update(memoryCatchupRunTable).set({ cancelled: true }).where(eq(memoryCatchupRunTable.id, runId)).returning().get()!);
	}).immediate();
}

export function readConversationMemories(database: Database, conversationId: number) {
	const db = drizzle(database);
	const state = readMemoryLabelState(database, conversationId);
	const path = db.select({ messageId: messageTable.id, author: messageTable.author_name, authorParticipantId: messageTable.author_participant_id }).from(messageTable).where(eq(messageTable.conversation_id, conversationId)).orderBy(asc(messageTable.position)).all();
	const rows = db.select({ messageId: messageTable.id, authorParticipantId: messageTable.author_participant_id, variantId: messageVariantTable.id, selected: messageVariantTable.selected, content: messageVariantTable.content, collection: memoryCollectionTable })
		.from(messageTable).innerJoin(messageVariantTable, eq(messageVariantTable.message_id, messageTable.id))
		.leftJoin(memoryCollectionTable, eq(memoryCollectionTable.variant_id, messageVariantTable.id))
		.leftJoin(activeGenerationTable, eq(activeGenerationTable.variant_id, messageVariantTable.id))
		.where(and(eq(messageTable.conversation_id, conversationId), or(eq(messageVariantTable.selected, true), isNotNull(memoryCollectionTable.variant_id)), isNull(activeGenerationTable.id)))
		.orderBy(desc(messageVariantTable.selected), asc(messageTable.position), asc(messageVariantTable.position)).all();
	const enabled = isMemoryEnabledForConversation(database, conversationId);
	const readiness = readMemoryIndexReadinessBatch(database, rows.flatMap(({ collection }) => collection ? [collection] : []), enabled);
	const sources = rows.flatMap(({ collection, ...variant }): MemoryCollectionView[] => {
		if (variant.authorParticipantId !== null && state.identities[variant.authorParticipantId]?.kind === "excluded") return [];
		if (collection) return [toView(collection, variant, readiness.get(variant.variantId)!)];
		return variant.content.trim().length === 0 ? [] : [unprocessedView(variant, enabled)];
	});
	return { sources, path, identities: state.identities, labelMerges: state.merges, labelRevision: state.revision };
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
			if (!hasValidMemoryClaimText(command.claim, command.attribution) || !hasValidMemoryPeople(command.people)) throw new InvalidMemorySourceError("Memory text, attribution, or person labels are invalid.");
			claims[index] = { ...claims[index]!, claim: command.claim, attribution: command.attribution, people: command.people, writerMaintained: true };
		} else claims.splice(index, 1);
		const updated = drizzle(database).update(memoryCollectionTable).set({ revision: row.revision + 1, ownership: "writer", status: "complete", error: null, claims_json: JSON.stringify(applyMemoryLabelRules(claims, readMemoryLabelState(database, conversationId))), work_epoch: row.work_epoch + 1, index_attempt_json: null, updated_at: new Date().toISOString() })
			.where(eq(memoryCollectionTable.variant_id, variantId)).returning().get()!;
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
		const updated = drizzle(database).update(memoryCollectionTable).set({ index_attempt_json: null }).where(eq(memoryCollectionTable.variant_id, variantId)).returning().get()!;
		return toView(updated, variant, readMemoryIndexReadiness(database, updated, enabled));
	}).immediate();
}

export class StaleMemoryAllowanceError extends Error {
	constructor(readonly expectedRevision: number, readonly actualRevision: number, readonly currentSettings: { revision: number; allowance: number; enabled: boolean }) {
		super("Memory Allowance changed in another session.");
		this.name = "StaleMemoryAllowanceError";
	}
}

// ==[HUMAN APPROVED]== Invalidate one source version whenever its text or selected status changes.
export function invalidateMemoryWorkForVariant(database: Database, variantId: number) {
	const row = readCollection(database, variantId);
	if (!row) return;
	const failed = row.ownership === "automatic" ? { status: "failed" as const, error: "This source changed after its Memory collection was created. Reset and re-extract it to create a collection for the current source version." } : {};
	drizzle(database).update(memoryCollectionTable).set({ work_epoch: row.work_epoch + 1, source_changed: true, updated_at: new Date().toISOString(), ...failed }).where(eq(memoryCollectionTable.variant_id, variantId)).run();
	abortMemoryWork(database, [variantId]);
}

const ensureChatState = (database: Database, conversationId: number) => {
	const db = drizzle(database);
	db.insert(conversationMemorySettingsTable).values({ conversation_id: conversationId }).onConflictDoNothing().run();
	const state = db.select().from(conversationMemorySettingsTable).where(eq(conversationMemorySettingsTable.conversation_id, conversationId)).get();
	if (!state) throw new InvalidMemorySourceError("This Chat no longer exists.");
	return state;
};

export function readMemoryAllowance(database: Database, conversationId: number) {
	const state = ensureChatState(database, conversationId);
	return { revision: state.revision, allowance: state.allowance, enabled: isMemoryEnabledForConversation(database, conversationId) };
}

export function setMemoryAllowance(database: Database, conversationId: number, expectedRevision: number, allowance: number) {
	if (!Number.isSafeInteger(allowance) || allowance < 0) throw new InvalidMemorySourceError("Memory Allowance must be a non-negative whole number of estimated tokens.");
	return database.transaction(() => {
		const current = ensureChatState(database, conversationId);
		if (current.revision !== expectedRevision) throw new StaleMemoryAllowanceError(expectedRevision, current.revision, { revision: current.revision, allowance: current.allowance, enabled: isMemoryEnabledForConversation(database, conversationId) });
		const next = current.revision + 1;
		drizzle(database).update(conversationMemorySettingsTable).set({ allowance, revision: next }).where(eq(conversationMemorySettingsTable.conversation_id, conversationId)).run();
		return { revision: next, allowance, enabled: isMemoryEnabledForConversation(database, conversationId) };
	}).immediate();
}

export interface MemoryWorkerOptions {
	process: (source: CapturedMemoryMessage, context: readonly CapturedMemoryMessage[], signal: AbortSignal, trace: MemoryTrace) => Promise<MemoryCandidateJudgment[]>;
	embed?: MemoryEmbed;
	concurrency?: number;
}

const claimNextMemoryJob = (database: Database) => database.transaction(() => {
	const db = drizzle(database);
	const extraction = db.select().from(memoryCollectionTable).where(and(eq(memoryCollectionTable.status, "pending"), eq(memoryCollectionTable.ownership, "automatic"))).orderBy(asc(memoryCollectionTable.catchup_run_id), asc(memoryCollectionTable.updated_at)).get();
	// ==[HUMAN APPROVED]== Live (non-catch-up) extraction outranks indexing; indexing runs only when no live extraction is waiting.
	const liveExtractionPending = extraction !== undefined && extraction.catchup_run_id === null;
	const index = liveExtractionPending ? undefined : claimMemoryIndexJob(database);
	if (index) return { kind: "index" as const, job: index };
	if (!extraction) return undefined;
	db.update(memoryCollectionTable).set({ status: "running", updated_at: new Date().toISOString() }).where(eq(memoryCollectionTable.variant_id, extraction.variant_id)).run();
	return { kind: "extract" as const, job: extraction };
}).immediate();

const runMemoryExtraction = async (database: Database, job: CollectionRow, process: MemoryWorkerOptions["process"], shutdown: AbortSignal) => {
	const db = drizzle(database);
	const current = and(eq(memoryCollectionTable.variant_id, job.variant_id), eq(memoryCollectionTable.work_epoch, job.work_epoch), eq(memoryCollectionTable.status, "running"));
	if (job.catchup_run_id !== null && !database.query<{ selected: number }, [number]>("SELECT selected FROM message_variant WHERE id=?").get(job.variant_id)?.selected) {
		db.delete(memoryCollectionTable).where(current).run();
		return;
	}
	const { signal, unregister } = registerMemoryWork(database, job.variant_id);
	const steps: MemoryTraceStep[] = [];
	const trace: MemoryTrace = (label, fields) => {
		if (signal.aborted || shutdown.aborted) return;
		steps.push({ label, at: new Date().toISOString(), fields });
		db.update(memoryCollectionTable).set({ trace_json: JSON.stringify(steps) }).where(and(eq(memoryCollectionTable.variant_id, job.variant_id), eq(memoryCollectionTable.work_epoch, job.work_epoch))).run();
	};
	try {
		const snapshot = Value.Parse(memoryWorkSnapshot, JSON.parse(job.source_snapshot_json));
		const claims = await process(snapshot.source, snapshot.context, AbortSignal.any([shutdown, signal]), trace);
		signal.throwIfAborted();
		database.transaction(() => {
			const merged = applyMemoryLabelRules(claims, readMemoryLabelState(database, job.conversation_id));
			db.update(memoryCollectionTable).set({ status: "complete", claims_json: JSON.stringify(merged), error: null, index_attempt_json: null, updated_at: new Date().toISOString() }).where(current).run();
		}).immediate();
	} catch (error) {
		if (shutdown.aborted) return;
		if (signal.aborted) return;
		const message = error instanceof Error ? error.message.slice(0, 1024) : "Memory extraction failed.";
		trace("Failed", { error: message });
		db.update(memoryCollectionTable).set({ status: "failed", error: message, updated_at: new Date().toISOString() }).where(current).run();
	} finally { unregister(); }
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
	drizzle(database).update(memoryCollectionTable).set({ status: "pending" }).where(and(eq(memoryCollectionTable.status, "running"), eq(memoryCollectionTable.ownership, "automatic"))).run();
	const workers = Array.from({ length: Math.min(2, Math.max(1, options.concurrency ?? 2)) }, loop);
	return async () => { shutdown.abort(); await Promise.all(workers); };
}

export function readMemoryTrace(database: Database, conversationId: number, variantId: number): MemoryTraceStep[] {
	const row = drizzle(database).select({ trace: memoryCollectionTable.trace_json }).from(memoryCollectionTable).where(and(eq(memoryCollectionTable.variant_id, variantId), eq(memoryCollectionTable.conversation_id, conversationId))).get();
	return row?.trace ? Value.Parse(memoryTraceSteps, JSON.parse(row.trace)) : [];
}
