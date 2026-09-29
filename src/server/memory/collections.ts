import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { readSelectedHistory, type SelectedHistoryRead } from "../conversation/selected-history";
import { activeGenerationTable, conversationMemorySettingsTable, memoryCatchupRunTable, memoryCollectionTable, memoryIndexWorkTable, messageTable, messageVariantTable } from "../database/schema";
import type { MemoryTrace } from "./extraction";
import type { MemoryIndexJob } from "./indexing";
import { cancelMemoryIndexWork, claimMemoryIndexWork, embedMemoryJob, failMemoryIndexWork, isMemoryEnabledForConversation, publishMemoryIndexVectors, queueAllMemoryIndexing, queueMemoryIndexForVariant, readMemoryIndexReadiness, readMemoryIndexReadinessBatch, registerMemoryIndexController, retryMemoryIndexing, requeueInterruptedMemoryIndexWork, StaleMemoryIndexRevisionError } from "./indexing";
import { Value } from "@sinclair/typebox/value";
import { memoryCandidates, memoryTraceSteps, memoryWorkSnapshot, type CapturedMemoryMessage, type MemoryCandidateJudgment, type MemoryCatchup, type MemoryCollectionView, type MemoryTraceStep } from "../../shared/contract/memory";
import { cancelMemoryExtractionWork, registerMemoryExtractionController } from "./extraction-jobs";
import { sha256 } from "./hash";

export class StaleMemoryCollectionError extends Error {
	constructor(readonly collection: MemoryCollectionView) { super("This Memory collection changed in another session."); this.name = "StaleMemoryCollectionError"; }
}

export class InvalidMemorySourceError extends Error {
	constructor(message: string) { super(message); this.name = "InvalidMemorySourceError"; }
}

const collectionStatus = (value: string): MemoryCollectionView["status"] => {
	if (value === "pending" || value === "running" || value === "complete" || value === "failed") return value;
	throw new Error("Memory collection has an invalid processing status.");
};
export const memoryOwnership = (value: string): MemoryCollectionView["ownership"] => {
	if (value === "automatic" || value === "writer") return value;
	throw new Error("Memory collection has an invalid ownership state.");
};
type SelectedMemoryMessage = SelectedHistoryRead["messages"][number];
type CapturedMemorySource = { source: CapturedMemoryMessage; context: readonly CapturedMemoryMessage[]; sourceHash: string };
const captureFromHistory = (target: SelectedMemoryMessage, previous: readonly SelectedMemoryMessage[]): CapturedMemorySource => {
	const variant = target.variant;
	if (!variant) throw new InvalidMemorySourceError("Memory can only process a retained selected Variant.");
	if (variant.content.trim().length === 0) throw new InvalidMemorySourceError("Empty sources are not processed. Save nonempty story content first.");
	const source: CapturedMemoryMessage = { messageId: target.id, variantId: variant.id, content: variant.content };
	const context = previous.flatMap((message) => message.variant ? [{ messageId: message.id, variantId: message.variant.id, content: message.variant.content }] : []);
	return { source, context, sourceHash: sha256(source.content) };
};
const capture = (database: Database, conversationId: number, messageId: number): CapturedMemorySource => {
	const source = database.query<{ id: number; position: number; variant_id: number; content: string }, [number, number]>("SELECT m.id, m.position, v.id AS variant_id, v.content FROM messages m JOIN message_variant v ON v.message_id=m.id AND v.selected=1 WHERE m.conversation_id=? AND m.id=?").get(conversationId, messageId);
	if (!source) throw new InvalidMemorySourceError("Memory can only process a retained selected Variant.");
	if (database.query<{ id: number }, [number]>("SELECT id FROM active_generation WHERE variant_id=?").get(source.variant_id)) throw new InvalidMemorySourceError("A provisional Generation is not eligible for Memory yet.");
	if (source.content.trim().length === 0) throw new InvalidMemorySourceError("Empty sources are not processed. Save nonempty story content first.");
	const previous = database.query<{ message_id: number; id: number; content: string }, [number, number]>("SELECT m.id AS message_id, v.id, v.content FROM messages m JOIN message_variant v ON v.message_id=m.id AND v.selected=1 WHERE m.conversation_id=? AND m.position<? ORDER BY m.position DESC LIMIT 4").all(conversationId, source.position).reverse();
	const capturedSource: CapturedMemoryMessage = { messageId, variantId: source.variant_id, content: source.content };
	const context = previous.map((message) => ({ messageId: message.message_id, variantId: message.id, content: message.content }));
	return { source: capturedSource, context, sourceHash: sha256(capturedSource.content) };
};

const ensureChatState = (database: Database, conversationId: number) => {
	const db = drizzle(database);
	db.insert(conversationMemorySettingsTable).values({ conversation_id: conversationId }).onConflictDoNothing().run();
	const state = db.select().from(conversationMemorySettingsTable).where(eq(conversationMemorySettingsTable.conversation_id, conversationId)).get();
	if (!state) throw new InvalidMemorySourceError("This Chat no longer exists.");
	return state;
};
const writeQueuedCollection = (database: Database, conversationId: number, messageId: number, captured: CapturedMemorySource, catchupRunId: number | null, current: typeof memoryCollectionTable.$inferSelect | undefined, now: string) => {
	const chat = ensureChatState(database, conversationId);
	const revision = (current?.revision ?? 0) + 1;
	const workEpoch = (current?.work_epoch ?? 0) + 1;
	const indexEpoch = (current?.index_epoch ?? 0) + 1;
	const values: typeof memoryCollectionTable.$inferInsert = {
		variant_id: captured.source.variantId, conversation_id: conversationId, message_id: messageId,
		source_hash: captured.sourceHash, revision, ownership: "automatic", work_epoch: workEpoch,
		chat_epoch: chat.chat_epoch, index_epoch: indexEpoch, status: "pending", error: null,
		source_snapshot_json: JSON.stringify({ source: captured.source, context: captured.context }),
		claims_json: "[]", trace_json: null, catchup_run_id: catchupRunId, source_changed: false, updated_at: now,
	};
	drizzle(database).insert(memoryCollectionTable).values(values).onConflictDoUpdate({ target: memoryCollectionTable.variant_id, set: values }).run();
	return { revision, variantId: captured.source.variantId };
};

// ==[HUMAN APPROVED]== Queue one explicit replacement using only its selected Variant and four prior selected Messages.
export function resetAndReextractMemorySource(database: Database, conversationId: number, messageId: number, variantId: number, expectedRevision: number): MemoryCollectionView {
	const db = drizzle(database);
	return database.transaction(() => {
		if (!isMemoryEnabledForConversation(database, conversationId)) throw new InvalidMemorySourceError("Turn on Memory and enable it in the selected Prompt Preset before remembering a source.");
		const confirmed = db.select({ selected: messageVariantTable.selected }).from(messageVariantTable).innerJoin(messageTable, eq(messageTable.id, messageVariantTable.message_id)).where(and(eq(messageVariantTable.id, variantId), eq(messageTable.id, messageId), eq(messageTable.conversation_id, conversationId))).get();
		if (!confirmed) throw new InvalidMemorySourceError("This source no longer exists.");
		const current = db.select().from(memoryCollectionTable).where(eq(memoryCollectionTable.variant_id, variantId)).get();
		if (!confirmed.selected || (current?.revision ?? 0) !== expectedRevision) {
			const collection = readConversationMemories(database, conversationId).sources.find((item) => item.variantId === variantId);
			if (!collection) throw new InvalidMemorySourceError("This source is no longer available for extraction.");
			throw new StaleMemoryCollectionError(collection);
		}
		const captured = capture(database, conversationId, messageId);
		const now = new Date().toISOString();
		const { revision } = writeQueuedCollection(database, conversationId, messageId, captured, null, current, now);
		cancelMemoryExtractionWork(database, variantId);
		db.delete(memoryIndexWorkTable).where(eq(memoryIndexWorkTable.variant_id, captured.source.variantId)).run();
		cancelMemoryIndexWork(database, captured.source.variantId);
		return {
			messageId, variantId: captured.source.variantId, selected: true, status: "pending" as const, error: null,
			revision, ownership: "automatic" as const, sourceChanged: false, claims: [],
			indexing: { status: "not-applicable" as const, pendingCount: 0, failedCount: 0, error: null },
		};
	}).immediate();
}

// ==[HUMAN APPROVED]== Queue selected source work from an authoritative write transaction.
export function queueMemorySource(database: Database, conversationId: number, messageId: number, catchupRunId: number | null = null, knownCapture?: CapturedMemorySource): boolean {
	if (!isMemoryEnabledForConversation(database, conversationId)) return false;
	let captured: CapturedMemorySource;
	try { captured = knownCapture ?? capture(database, conversationId, messageId); } catch { return false; }
	const db = drizzle(database);
	const current = db.select().from(memoryCollectionTable).where(eq(memoryCollectionTable.variant_id, captured.source.variantId)).get();
	if (current?.ownership === "writer") return false;
	if (current && current.source_hash === captured.sourceHash && ["pending", "running"].includes(current.status)) {
		if (current.catchup_run_id !== null && current.catchup_run_id !== catchupRunId) db.update(memoryCollectionTable).set({ catchup_run_id: catchupRunId, updated_at: new Date().toISOString() }).where(eq(memoryCollectionTable.variant_id, current.variant_id)).run();
		return false;
	}
	if (current && current.source_hash === captured.sourceHash && current.status === "complete") return false;
	const { variantId } = writeQueuedCollection(database, conversationId, messageId, captured, catchupRunId, current, new Date().toISOString());
	db.delete(memoryIndexWorkTable).where(eq(memoryIndexWorkTable.variant_id, variantId)).run();
	cancelMemoryExtractionWork(database, variantId);
	cancelMemoryIndexWork(database, variantId);
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
		const created = drizzle(database).insert(memoryCatchupRunTable).values({ conversation_id: conversationId, state: "running", created_at: new Date().toISOString() }).returning({ id: memoryCatchupRunTable.id }).get();
		if (!created) throw new InvalidMemorySourceError("History catch-up could not be saved.");
		const activeVariants = new Set(drizzle(database).select({ id: activeGenerationTable.variant_id }).from(activeGenerationTable).where(eq(activeGenerationTable.conversation_id, conversationId)).all().map(({ id }) => id));
		const previous: SelectedMemoryMessage[] = [];
		for (const message of history.messages) {
			if (message.variant) {
				if (message.variant.content.trim().length > 0 && !activeVariants.has(message.variant.id)) queueMemorySource(database, conversationId, message.id, created.id, captureFromHistory(message, previous));
				previous.push(message);
				if (previous.length > 4) previous.shift();
			}
		}
		return readMemoryCatchup(database, created.id);
	}).immediate();
}

export function readMemoryCatchup(database: Database, runId: number): MemoryCatchup {
	const db = drizzle(database);
	const run = db.select().from(memoryCatchupRunTable).where(eq(memoryCatchupRunTable.id, runId)).get();
	if (!run) throw new InvalidMemorySourceError("This history catch-up run no longer exists.");
	const jobs = db.select({ status: memoryCollectionTable.status, messageId: memoryCollectionTable.message_id, error: memoryCollectionTable.error }).from(memoryCollectionTable).where(eq(memoryCollectionTable.catchup_run_id, runId)).all();
	const pending = jobs.filter((job) => job.status === "pending").length;
	const running = jobs.filter((job) => job.status === "running").length;
	const failed = jobs.filter((job) => job.status === "failed").map((job) => ({ messageId: job.messageId, error: job.error }));
	let state: MemoryCatchup["state"];
	switch (run.state) {
		case "running": case "complete": case "failed": case "cancelled": state = run.state; break;
		default: throw new InvalidMemorySourceError("This history catch-up run has an invalid state.");
	}
	if (state === "running" && pending + running === 0) {
		state = failed.length ? "failed" : "complete";
		db.update(memoryCatchupRunTable).set({ state }).where(eq(memoryCatchupRunTable.id, runId)).run();
	}
	return { id: runId, state, pending, running, complete: jobs.filter((job) => job.status === "complete").length, failed };
}

export function readLatestMemoryCatchup(database: Database, conversationId: number): MemoryCatchup | null {
	const run = drizzle(database).select({ id: memoryCatchupRunTable.id }).from(memoryCatchupRunTable).where(eq(memoryCatchupRunTable.conversation_id, conversationId)).orderBy(desc(memoryCatchupRunTable.id)).get();
	return run ? readMemoryCatchup(database, run.id) : null;
}

export function cancelMemoryCatchup(database: Database, conversationId: number, runId: number): MemoryCatchup {
	return database.transaction(() => {
		const db = drizzle(database);
		const run = db.select().from(memoryCatchupRunTable).where(and(eq(memoryCatchupRunTable.id, runId), eq(memoryCatchupRunTable.conversation_id, conversationId))).get();
		if (!run || run.state !== "running") throw new InvalidMemorySourceError("This history catch-up run is no longer active.");
		const activeVariants = db.select({ variantId: memoryCollectionTable.variant_id }).from(memoryCollectionTable).where(and(eq(memoryCollectionTable.catchup_run_id, runId), eq(memoryCollectionTable.status, "running"))).all().map(({ variantId }) => variantId);
		db.delete(memoryCollectionTable).where(and(eq(memoryCollectionTable.catchup_run_id, runId), eq(memoryCollectionTable.status, "pending"))).run();
		db.update(memoryCollectionTable).set({ work_epoch: sql`${memoryCollectionTable.work_epoch} + 1`, status: "failed", error: "History catch-up was cancelled.", catchup_run_id: null, updated_at: new Date().toISOString() }).where(and(eq(memoryCollectionTable.catchup_run_id, runId), eq(memoryCollectionTable.status, "running"))).run();
		for (const variantId of activeVariants) cancelMemoryExtractionWork(database, variantId);
		db.update(memoryCatchupRunTable).set({ state: "cancelled" }).where(eq(memoryCatchupRunTable.id, runId)).run();
		return readMemoryCatchup(database, runId);
	}).immediate();
}

export function readConversationMemories(database: Database, conversationId: number) {
	const db = drizzle(database);
	const path = db.select({ messageId: messageTable.id, author: messageTable.author_name }).from(messageTable).where(eq(messageTable.conversation_id, conversationId)).orderBy(asc(messageTable.position)).all();
	const rows = db.select({
		messageId: messageTable.id, variantId: messageVariantTable.id, selected: messageVariantTable.selected, content: messageVariantTable.content,
		collection: { variant_id: memoryCollectionTable.variant_id, source_hash: memoryCollectionTable.source_hash, source_changed: memoryCollectionTable.source_changed, claims_json: memoryCollectionTable.claims_json, ownership: memoryCollectionTable.ownership, status: memoryCollectionTable.status, error: memoryCollectionTable.error, revision: memoryCollectionTable.revision, index_epoch: memoryCollectionTable.index_epoch },
	}).from(messageTable).innerJoin(messageVariantTable, eq(messageVariantTable.message_id, messageTable.id))
		.leftJoin(memoryCollectionTable, eq(memoryCollectionTable.variant_id, messageVariantTable.id))
		.leftJoin(activeGenerationTable, eq(activeGenerationTable.variant_id, messageVariantTable.id))
		.where(and(eq(messageTable.conversation_id, conversationId), or(eq(messageVariantTable.selected, true), isNotNull(memoryCollectionTable.variant_id)), isNull(activeGenerationTable.id)))
		.orderBy(desc(messageVariantTable.selected), asc(messageTable.position), asc(messageVariantTable.position)).all();
	const enabled = isMemoryEnabledForConversation(database, conversationId);
	const readiness = readMemoryIndexReadinessBatch(database, rows.flatMap(({ collection }) => collection ? [collection] : []), enabled);
	const sources = rows.flatMap(({ messageId, variantId, selected, content, collection: row }): MemoryCollectionView[] => {
		if (!row && content.trim().length === 0) return [];
		if (!row) return [{ messageId, variantId, selected, status: "unprocessed" as const, error: null, revision: 0, ownership: "automatic" as const, sourceChanged: false, claims: [], indexing: { status: enabled ? "not-applicable" as const : "disabled" as const, pendingCount: 0, failedCount: 0, error: null } }];
		const sourceChanged = row.source_changed || sha256(content) !== row.source_hash || (row.status === "failed" && Boolean(row.error?.startsWith("This source changed")));
		let claims: MemoryCandidateJudgment[] = [];
		try { claims = Value.Parse(memoryCandidates, JSON.parse(row.claims_json)); } catch { claims = []; }
		const ownership = memoryOwnership(row.ownership);
		const error = sourceChanged ? ownership === "writer" ? "This source changed. Automatic updates are paused for this writer-maintained collection." : row.error ?? "This source changed after its Memory collection was created." : row.error;
		return [{ messageId, variantId, selected, status: sourceChanged ? "stale" as const : collectionStatus(row.status), error, revision: row.revision, ownership, sourceChanged, claims: sourceChanged && ownership === "automatic" ? [] : claims, indexing: readiness.get(variantId)! }];
	});
	return { sources, path };
}

export function correctMemorySource(database: Database, conversationId: number, messageId: number, variantId: number, expectedRevision: number, index: number, operation: "edit" | "remove", replacement?: { claim: string; attribution: string; people: string[] }): MemoryCollectionView {
	return database.transaction(() => {
		const db = drizzle(database);
		const selected = db.select({ variantId: messageVariantTable.id, content: messageVariantTable.content, isSelected: messageVariantTable.selected }).from(messageVariantTable).innerJoin(messageTable, eq(messageTable.id, messageVariantTable.message_id)).where(and(eq(messageTable.conversation_id, conversationId), eq(messageTable.id, messageId), eq(messageVariantTable.id, variantId))).get();
		if (!selected) throw new InvalidMemorySourceError("This source no longer exists.");
		const row = db.select().from(memoryCollectionTable).where(eq(memoryCollectionTable.variant_id, variantId)).get();
		if (!row) throw new InvalidMemorySourceError("This source has no saved Memory collection to correct.");
		let claims: MemoryCandidateJudgment[];
		try { claims = Value.Parse(memoryCandidates, JSON.parse(row.claims_json)); } catch { throw new InvalidMemorySourceError("This Memory collection cannot be edited because its saved content is invalid."); }
		const view = (values: MemoryCandidateJudgment[], revision = row.revision): MemoryCollectionView => ({ messageId, variantId, selected: selected.isSelected, status: row.source_changed || sha256(selected.content) !== row.source_hash ? "stale" : collectionStatus(row.status), error: row.error, revision, ownership: memoryOwnership(row.ownership), sourceChanged: row.source_changed || sha256(selected.content) !== row.source_hash, claims: values, indexing: readMemoryIndexReadiness(database, row, isMemoryEnabledForConversation(database, conversationId)) });
		if (row.revision !== expectedRevision) throw new StaleMemoryCollectionError(view(claims));
		if (!Number.isSafeInteger(index) || index < 0 || index >= claims.length) throw new InvalidMemorySourceError("This Memory no longer exists in the source collection.");
		if (operation === "edit") {
			if (!replacement || !replacement.claim.trim() || !replacement.attribution.trim() || replacement.claim.length + replacement.attribution.length > 1024 || replacement.people.some((person) => !person.trim()) || new Set(replacement.people).size !== replacement.people.length) throw new InvalidMemorySourceError("Memory text, attribution, or person labels are invalid.");
			claims[index] = { ...claims[index]!, ...replacement, writerMaintained: true };
		} else claims.splice(index, 1);
		const revision = row.revision + 1;
		cancelMemoryExtractionWork(database, variantId);
		cancelMemoryIndexWork(database, variantId);
		db.update(memoryCollectionTable).set({ revision, ownership: "writer", status: "complete", error: null, claims_json: JSON.stringify(claims), work_epoch: row.work_epoch + 1, updated_at: new Date().toISOString() }).where(and(eq(memoryCollectionTable.variant_id, row.variant_id), eq(memoryCollectionTable.revision, row.revision))).run();
		queueMemoryIndexForVariant(database, variantId);
		const updated = db.select().from(memoryCollectionTable).where(eq(memoryCollectionTable.variant_id, variantId)).get();
		const corrected = view(claims, revision);
		return { ...corrected, indexing: updated ? readMemoryIndexReadiness(database, updated, isMemoryEnabledForConversation(database, conversationId)) : corrected.indexing, status: corrected.sourceChanged ? "stale" as const : "complete" as const, error: corrected.sourceChanged ? "This source changed. Automatic updates are paused for this writer-maintained collection." : null, ownership: "writer" as const };
	}).immediate();
}

export function retryMemorySourceIndex(database: Database, conversationId: number, messageId: number, variantId: number, expectedRevision: number): MemoryCollectionView {
	const current = readConversationMemories(database, conversationId).sources.find((item) => item.variantId === variantId && item.messageId === messageId);
	if (!current) throw new InvalidMemorySourceError("This source has no saved Memory collection to index.");
	if (current.revision !== expectedRevision) throw new StaleMemoryCollectionError(current);
	try { retryMemoryIndexing(database, conversationId, variantId, expectedRevision); }
	catch (error) {
		if (error instanceof StaleMemoryIndexRevisionError) throw new StaleMemoryCollectionError(current);
		throw error;
	}
	return readConversationMemories(database, conversationId).sources.find((item) => item.variantId === variantId && item.messageId === messageId) ?? current;
}

export class StaleMemoryAllowanceError extends Error {
	constructor(readonly expectedRevision: number, readonly actualRevision: number, readonly currentSettings: { revision: number; allowance: number; enabled: boolean }) {
		super("Memory Allowance changed in another session.");
		this.name = "StaleMemoryAllowanceError";
	}
}

// ==[HUMAN APPROVED]== Invalidate one source version whenever its text or selected status changes.
export function invalidateMemoryWorkForVariant(database: Database, variantId: number) {
	const db = drizzle(database);
	const automatic = db.select({ variantId: memoryCollectionTable.variant_id }).from(memoryCollectionTable).where(and(eq(memoryCollectionTable.variant_id, variantId), eq(memoryCollectionTable.ownership, "automatic"))).get();
	if (automatic) {
		cancelMemoryExtractionWork(database, variantId);
		cancelMemoryIndexWork(database, variantId);
	}
	db.update(memoryCollectionTable).set({ work_epoch: sql`${memoryCollectionTable.work_epoch} + 1`, source_changed: true, updated_at: new Date().toISOString() }).where(eq(memoryCollectionTable.variant_id, variantId)).run();
	if (automatic) {
		db.update(memoryCollectionTable).set({ status: "failed", error: "This source changed after its Memory collection was created. Reset and re-extract it to create a collection for the current source version." }).where(and(eq(memoryCollectionTable.variant_id, variantId), eq(memoryCollectionTable.ownership, "automatic"))).run();
		db.update(memoryCollectionTable).set({ index_epoch: sql`${memoryCollectionTable.index_epoch} + 1` }).where(eq(memoryCollectionTable.variant_id, variantId)).run();
		db.delete(memoryIndexWorkTable).where(eq(memoryIndexWorkTable.variant_id, variantId)).run();
	}
}

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
	index?: (job: MemoryIndexJob, signal: AbortSignal) => Promise<readonly { renderedText: string; vector: readonly number[] }[]>;
	concurrency?: number;
}

const extractionIsCurrent = (current: typeof memoryCollectionTable.$inferSelect | undefined, job: typeof memoryCollectionTable.$inferSelect): current is typeof memoryCollectionTable.$inferSelect =>
	current?.status === "running" && current.revision === job.revision && current.work_epoch === job.work_epoch && current.chat_epoch === job.chat_epoch && current.source_hash === job.source_hash && !current.source_changed && current.ownership === "automatic";

export function startMemoryWorker(database: Database, options: MemoryWorkerOptions) {
	let stopped = false;
	const controller = new AbortController();
	const concurrency = Math.min(2, Math.max(1, options.concurrency ?? 2));
	const runOne = async () => {
		while (!stopped) {
			const next = database.transaction(() => {
				const db = drizzle(database);
				const extraction = db.select().from(memoryCollectionTable).where(and(eq(memoryCollectionTable.status, "pending"), eq(memoryCollectionTable.ownership, "automatic"))).orderBy(asc(memoryCollectionTable.catchup_run_id), asc(memoryCollectionTable.updated_at)).get();
				const indexing = db.select().from(memoryIndexWorkTable).where(eq(memoryIndexWorkTable.status, "pending")).orderBy(asc(memoryIndexWorkTable.updated_at)).get();
				const extractionPriority = extraction?.catchup_run_id === null ? 0 : 2;
				const indexingPriority = 1;
				if (extraction && (!indexing || extractionPriority < indexingPriority)) {
					const claimed = db.update(memoryCollectionTable).set({ status: "running", updated_at: new Date().toISOString() }).where(and(eq(memoryCollectionTable.variant_id, extraction.variant_id), eq(memoryCollectionTable.status, "pending"), eq(memoryCollectionTable.ownership, "automatic"))).returning({ variantId: memoryCollectionTable.variant_id }).get();
					return claimed ? { kind: "extraction" as const, job: { ...extraction, status: "running" as const } } : undefined;
				}
				return undefined;
			}).immediate();
			const indexJob = next?.kind === "extraction" ? undefined : claimMemoryIndexWork(database);
			const job = next?.kind === "extraction" ? next.job : undefined;
			const steps: MemoryTraceStep[] = [];
			const trace: MemoryTrace = (label, fields) => {
				if (!job) return;
				steps.push({ label, at: new Date().toISOString(), fields });
				drizzle(database).update(memoryCollectionTable).set({ trace_json: JSON.stringify(steps) }).where(and(eq(memoryCollectionTable.variant_id, job.variant_id), eq(memoryCollectionTable.work_epoch, job.work_epoch))).run();
			};
			if (!job && !indexJob) { await new Promise((resolve) => setTimeout(resolve, 300)); continue; }
			const extractionController = job ? new AbortController() : undefined;
			const unregisterExtraction = job && extractionController ? registerMemoryExtractionController(database, job.variant_id, extractionController) : () => {};
			try {
				if (indexJob) {
					const jobController = new AbortController();
					const unregister = registerMemoryIndexController(database, indexJob.variantId, jobController);
					try {
						const signal = AbortSignal.any([controller.signal, jobController.signal]);
						const vectors = await (options.index ?? ((item, jobSignal) => embedMemoryJob(database, item, undefined, jobSignal)))(indexJob, signal);
						publishMemoryIndexVectors(database, indexJob, vectors);
					} finally { unregister(); }
					continue;
				}
				if (!job || !extractionController) continue;
				if (job.catchup_run_id !== null) {
					const selected = database.query<{ selected: number }, [number]>("SELECT selected FROM message_variant WHERE id=?").get(job.variant_id);
					if (!selected?.selected) {
						drizzle(database).delete(memoryCollectionTable).where(and(eq(memoryCollectionTable.variant_id, job.variant_id), eq(memoryCollectionTable.catchup_run_id, job.catchup_run_id), eq(memoryCollectionTable.status, "running"))).run();
						continue;
					}
				}
				const source = database.query<{ content: string }, [number, number]>("SELECT v.content FROM message_variant v JOIN messages m ON m.id=v.message_id WHERE v.id=? AND m.conversation_id=?").get(job.variant_id, job.conversation_id);
				const chat = drizzle(database).select().from(conversationMemorySettingsTable).where(eq(conversationMemorySettingsTable.conversation_id, job.conversation_id)).get();
				const current = drizzle(database).select().from(memoryCollectionTable).where(eq(memoryCollectionTable.variant_id, job.variant_id)).get();
				if (!source || !chat || !extractionIsCurrent(current, job) || chat.chat_epoch !== job.chat_epoch || sha256(source.content) !== job.source_hash || !isMemoryEnabledForConversation(database, job.conversation_id)) {
					drizzle(database).update(memoryCollectionTable).set({ status: "failed", error: "This source or its Memory settings changed before extraction began. Reset and re-extract it when Memory is enabled.", updated_at: new Date().toISOString() }).where(and(eq(memoryCollectionTable.variant_id, job.variant_id), eq(memoryCollectionTable.status, "running"), eq(memoryCollectionTable.revision, job.revision), eq(memoryCollectionTable.work_epoch, job.work_epoch), eq(memoryCollectionTable.ownership, "automatic"))).run();
					continue;
				}
				const snapshot = Value.Parse(memoryWorkSnapshot, JSON.parse(job.source_snapshot_json));
				const claims = await options.process(snapshot.source, snapshot.context, AbortSignal.any([controller.signal, extractionController.signal]), trace);
				database.transaction(() => {
					const finalSource = database.query<{ content: string }, [number, number]>("SELECT v.content FROM message_variant v JOIN messages m ON m.id=v.message_id WHERE v.id=? AND m.conversation_id=?").get(job.variant_id, job.conversation_id);
					const finalChat = drizzle(database).select().from(conversationMemorySettingsTable).where(eq(conversationMemorySettingsTable.conversation_id, job.conversation_id)).get();
					const finalCollection = drizzle(database).select().from(memoryCollectionTable).where(eq(memoryCollectionTable.variant_id, job.variant_id)).get();
					const currentHash = finalSource ? sha256(finalSource.content) : "";
					if (finalSource && finalChat && extractionIsCurrent(finalCollection, job) && finalChat.chat_epoch === job.chat_epoch && finalCollection.source_hash === currentHash && isMemoryEnabledForConversation(database, job.conversation_id)) {
						drizzle(database).update(memoryCollectionTable).set({ status: "complete", claims_json: JSON.stringify(claims), error: null, updated_at: new Date().toISOString() }).where(and(eq(memoryCollectionTable.variant_id, job.variant_id), eq(memoryCollectionTable.revision, job.revision), eq(memoryCollectionTable.work_epoch, job.work_epoch), eq(memoryCollectionTable.chat_epoch, job.chat_epoch), eq(memoryCollectionTable.source_hash, job.source_hash), eq(memoryCollectionTable.status, "running"), eq(memoryCollectionTable.ownership, "automatic"), eq(memoryCollectionTable.source_changed, false))).run();
						queueMemoryIndexForVariant(database, job.variant_id);
					}
				}).immediate();
			} catch (error) {
				if (stopped || extractionController?.signal.aborted) continue;
				if (indexJob) { failMemoryIndexWork(database, indexJob, error instanceof Error ? error : new Error("Memory indexing failed.")); continue; }
				if (!job) continue;
				const message = error instanceof Error ? error.message.slice(0, 1024) : "Memory extraction failed.";
				trace("Failed", { error: message });
				drizzle(database).update(memoryCollectionTable).set({ status: "failed", error: message, updated_at: new Date().toISOString() }).where(and(eq(memoryCollectionTable.variant_id, job.variant_id), eq(memoryCollectionTable.revision, job.revision), eq(memoryCollectionTable.work_epoch, job.work_epoch), eq(memoryCollectionTable.status, "running"), eq(memoryCollectionTable.ownership, "automatic"))).run();
			} finally {
				unregisterExtraction();
			}
		}
	};
	drizzle(database).update(memoryCollectionTable).set({ status: "pending", updated_at: new Date().toISOString() }).where(and(eq(memoryCollectionTable.status, "running"), eq(memoryCollectionTable.ownership, "automatic"))).run();
	requeueInterruptedMemoryIndexWork(database);
	queueAllMemoryIndexing(database);
	const workers = Array.from({ length: concurrency }, runOne);
	return async () => { stopped = true; controller.abort(); await Promise.all(workers); };
}

export function readMemoryTrace(database: Database, conversationId: number, variantId: number): MemoryTraceStep[] {
	const row = drizzle(database).select({ trace: memoryCollectionTable.trace_json }).from(memoryCollectionTable).where(and(eq(memoryCollectionTable.variant_id, variantId), eq(memoryCollectionTable.conversation_id, conversationId))).get();
	return row?.trace ? Value.Parse(memoryTraceSteps, JSON.parse(row.trace)) : [];
}
