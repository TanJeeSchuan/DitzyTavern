import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { readSelectedHistory } from "../conversation/selected-history";
import { activeGenerationTable, conversationMemorySettingsTable, memoryCatchupRunTable, memoryCollectionTable, memoryIndexWorkTable, messageTable, messageVariantTable } from "../database/schema";
import type { MemoryCandidateJudgment, CapturedMemoryMessage, MemoryTrace } from "./extraction";
import type { MemoryIndexJob } from "./indexing";
import { cancelMemoryIndexWork, claimMemoryIndexWork, embedMemoryJob, failMemoryIndexWork, isMemoryEnabledForConversation, publishMemoryIndexVectors, queueAllMemoryIndexing, queueMemoryIndexForVariant, readMemoryIndexReadiness, registerMemoryIndexController, retryMemoryIndexing, requeueInterruptedMemoryIndexWork, StaleMemoryIndexRevisionError, type MemoryIndexReadiness } from "./indexing";
import { Value } from "@sinclair/typebox/value";
import { memoryCandidates, memoryTraceSteps, memoryWorkSnapshot, type MemoryTraceStep } from "../../shared/contract/memory";
import { sha256 } from "./hash";

export interface MemoryCollectionView {
	messageId: number;
	variantId: number;
	selected: boolean;
	status: "unprocessed" | "stale" | "pending" | "running" | "complete" | "failed";
	error: string | null;
	revision: number;
	ownership: "automatic" | "writer";
	sourceChanged: boolean;
	claims: MemoryCandidateJudgment[];
	indexing: MemoryIndexReadiness;
}

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
const capture = (database: Database, conversationId: number, messageId: number) => {
	const selected = readSelectedHistory(database, conversationId, { targetMessageId: messageId });
	if (!selected?.target) throw new InvalidMemorySourceError("This source no longer belongs to the selected Chat.");
	const variant = selected.target.variant;
	if (!variant) throw new InvalidMemorySourceError("Memory can only process a retained selected Variant.");
	if (drizzle(database).select({ id: activeGenerationTable.id }).from(activeGenerationTable).where(eq(activeGenerationTable.variant_id, variant.id)).get()) throw new InvalidMemorySourceError("A provisional Generation is not eligible for Memory yet.");
	if (variant.content.trim().length === 0) throw new InvalidMemorySourceError("Empty sources are not processed. Save nonempty story content first.");
	const previous = selected.messages.filter((message) => message.variant).slice(-4);
	const source: CapturedMemoryMessage = { messageId, variantId: variant.id, content: variant.content };
	const context = previous.map((message) => ({ messageId: message.id, variantId: message.variant!.id, content: message.variant!.content }));
	return { source, context, sourceHash: sha256(source.content) };
};

const ensureChatState = (database: Database, conversationId: number) => {
	const db = drizzle(database);
	db.insert(conversationMemorySettingsTable).values({ conversation_id: conversationId }).onConflictDoNothing().run();
	const state = db.select().from(conversationMemorySettingsTable).where(eq(conversationMemorySettingsTable.conversation_id, conversationId)).get();
	if (!state) throw new InvalidMemorySourceError("This Chat no longer exists.");
	return state;
};

// ==[HUMAN APPROVED]== Queue one explicit replacement using only its selected Variant and four prior selected Messages.
export function resetAndReextractMemorySource(database: Database, conversationId: number, messageId: number): MemoryCollectionView {
	const db = drizzle(database);
	return database.transaction(() => {
		if (!isMemoryEnabledForConversation(database, conversationId)) throw new InvalidMemorySourceError("Enable Memory in the selected Prompt Preset before remembering a source.");
		const captured = capture(database, conversationId, messageId);
		const chat = ensureChatState(database, conversationId);
		const current = db.select().from(memoryCollectionTable).where(eq(memoryCollectionTable.variant_id, captured.source.variantId)).get();
		const now = new Date().toISOString();
		const revision = (current?.revision ?? 0) + 1;
		const workEpoch = (current?.work_epoch ?? 0) + 1;
		const sourceEpoch = (current?.source_epoch ?? 0) + 1;
		const indexEpoch = (current?.index_epoch ?? 0) + 1;
		const sourceSnapshot = JSON.stringify({ source: captured.source, context: captured.context });
		db.insert(memoryCollectionTable).values({
			variant_id: captured.source.variantId,
			conversation_id: conversationId,
			message_id: messageId,
			source_hash: captured.sourceHash,
			revision,
			ownership: "automatic",
			work_epoch: workEpoch,
			source_epoch: sourceEpoch,
			chat_epoch: chat.chat_epoch,
			index_epoch: indexEpoch,
			status: "pending",
			error: null,
			source_snapshot_json: sourceSnapshot,
			claims_json: "[]",
			provenance_json: "[]",
			catchup_run_id: null,
			source_changed: false,
			updated_at: now,
		}).onConflictDoUpdate({
			target: memoryCollectionTable.variant_id,
			set: {
				conversation_id: conversationId, message_id: messageId, source_hash: captured.sourceHash,
				revision, ownership: "automatic", work_epoch: workEpoch, source_epoch: sourceEpoch, chat_epoch: chat.chat_epoch,
				index_epoch: indexEpoch,
				status: "pending", error: null, source_snapshot_json: sourceSnapshot,
				claims_json: "[]", provenance_json: "[]", trace_json: null, source_changed: false, updated_at: now,
				catchup_run_id: null,
			},
		}).run();
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
export function queueMemorySource(database: Database, conversationId: number, messageId: number, catchupRunId: number | null = null): boolean {
	if (!isMemoryEnabledForConversation(database, conversationId)) return false;
	let captured: ReturnType<typeof capture>;
	try { captured = capture(database, conversationId, messageId); } catch { return false; }
	const db = drizzle(database);
	const current = db.select().from(memoryCollectionTable).where(eq(memoryCollectionTable.variant_id, captured.source.variantId)).get();
	if (current?.ownership === "writer") return false;
	if (current && current.source_hash === captured.sourceHash && ["pending", "running"].includes(current.status)) {
		if (current.catchup_run_id !== null && current.catchup_run_id !== catchupRunId) db.update(memoryCollectionTable).set({ catchup_run_id: catchupRunId, updated_at: new Date().toISOString() }).where(eq(memoryCollectionTable.variant_id, current.variant_id)).run();
		return false;
	}
	if (current && current.source_hash === captured.sourceHash && current.status === "complete") return false;
	const chat = ensureChatState(database, conversationId);
	const now = new Date().toISOString();
	const revision = (current?.revision ?? 0) + 1;
	const workEpoch = (current?.work_epoch ?? 0) + 1;
	const sourceEpoch = (current?.source_epoch ?? 0) + 1;
	const indexEpoch = (current?.index_epoch ?? 0) + 1;
	db.insert(memoryCollectionTable).values({ variant_id: captured.source.variantId, conversation_id: conversationId, message_id: messageId, source_hash: captured.sourceHash, revision, ownership: "automatic", work_epoch: workEpoch, source_epoch: sourceEpoch, chat_epoch: chat.chat_epoch, index_epoch: indexEpoch, status: "pending", error: null, source_snapshot_json: JSON.stringify({ source: captured.source, context: captured.context }), claims_json: "[]", provenance_json: "[]", catchup_run_id: catchupRunId, updated_at: now }).onConflictDoUpdate({
		target: memoryCollectionTable.variant_id,
				set: { conversation_id: conversationId, message_id: messageId, source_hash: captured.sourceHash, revision, ownership: "automatic", work_epoch: workEpoch, source_epoch: sourceEpoch, chat_epoch: chat.chat_epoch, index_epoch: indexEpoch, status: "pending", error: null, source_snapshot_json: JSON.stringify({ source: captured.source, context: captured.context }), claims_json: "[]", provenance_json: "[]", trace_json: null, catchup_run_id: catchupRunId, source_changed: false, updated_at: now },
	}).run();
	db.delete(memoryIndexWorkTable).where(eq(memoryIndexWorkTable.variant_id, captured.source.variantId)).run();
	cancelMemoryIndexWork(database, captured.source.variantId);
	return true;
}

export function queueMemoryTail(database: Database, conversationId: number): boolean {
	const history = readSelectedHistory(database, conversationId);
	const tail = history?.messages.at(-1);
	return tail?.variant ? queueMemorySource(database, conversationId, tail.id) : false;
}

export interface MemoryCatchupView {
	id: number;
	state: "running" | "complete" | "failed" | "cancelled";
	pending: number;
	running: number;
	complete: number;
	failed: { messageId: number; error: string | null }[];
}

export function startMemoryCatchup(database: Database, conversationId: number): MemoryCatchupView {
	return database.transaction(() => {
		if (!isMemoryEnabledForConversation(database, conversationId)) throw new InvalidMemorySourceError("Enable Memory in the selected Prompt Preset before remembering history.");
		const history = readSelectedHistory(database, conversationId);
		if (!history) throw new InvalidMemorySourceError("This Chat no longer exists.");
		const path = history.messages.flatMap((message) => message.variant ? [{ messageId: message.id, variantId: message.variant.id }] : []);
		const created = drizzle(database).insert(memoryCatchupRunTable).values({ conversation_id: conversationId, state: "running", created_at: new Date().toISOString() }).returning({ id: memoryCatchupRunTable.id }).get();
		if (!created) throw new InvalidMemorySourceError("History catch-up could not be saved.");
		for (const { messageId, variantId } of path) {
			const active = drizzle(database).select({ id: activeGenerationTable.id }).from(activeGenerationTable).where(eq(activeGenerationTable.variant_id, variantId)).get();
			if (active) continue;
			queueMemorySource(database, conversationId, messageId, created.id);
		}
		return readMemoryCatchup(database, created.id);
	}).immediate();
}

export function readMemoryCatchup(database: Database, runId: number): MemoryCatchupView {
	const db = drizzle(database);
	const run = db.select().from(memoryCatchupRunTable).where(eq(memoryCatchupRunTable.id, runId)).get();
	if (!run) throw new InvalidMemorySourceError("This history catch-up run no longer exists.");
	const jobs = db.select({ status: memoryCollectionTable.status, messageId: memoryCollectionTable.message_id, error: memoryCollectionTable.error }).from(memoryCollectionTable).where(eq(memoryCollectionTable.catchup_run_id, runId)).all();
	const pending = jobs.filter((job) => job.status === "pending").length;
	const running = jobs.filter((job) => job.status === "running").length;
	const failed = jobs.filter((job) => job.status === "failed").map((job) => ({ messageId: job.messageId, error: job.error }));
	let state: MemoryCatchupView["state"];
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

export function readLatestMemoryCatchup(database: Database, conversationId: number): MemoryCatchupView | null {
	const run = drizzle(database).select({ id: memoryCatchupRunTable.id }).from(memoryCatchupRunTable).where(eq(memoryCatchupRunTable.conversation_id, conversationId)).orderBy(desc(memoryCatchupRunTable.id)).get();
	return run ? readMemoryCatchup(database, run.id) : null;
}

export function cancelMemoryCatchup(database: Database, conversationId: number, runId: number): MemoryCatchupView {
	return database.transaction(() => {
		const db = drizzle(database);
		const run = db.select().from(memoryCatchupRunTable).where(and(eq(memoryCatchupRunTable.id, runId), eq(memoryCatchupRunTable.conversation_id, conversationId))).get();
		if (!run || run.state !== "running") throw new InvalidMemorySourceError("This history catch-up run is no longer active.");
		db.delete(memoryCollectionTable).where(and(eq(memoryCollectionTable.catchup_run_id, runId), eq(memoryCollectionTable.status, "pending"))).run();
		db.update(memoryCollectionTable).set({ work_epoch: sql`${memoryCollectionTable.work_epoch} + 1`, status: "failed", error: "History catch-up was cancelled.", catchup_run_id: null, updated_at: new Date().toISOString() }).where(and(eq(memoryCollectionTable.catchup_run_id, runId), eq(memoryCollectionTable.status, "running"))).run();
		db.update(memoryCatchupRunTable).set({ state: "cancelled" }).where(eq(memoryCatchupRunTable.id, runId)).run();
		return readMemoryCatchup(database, runId);
	}).immediate();
}

export function readConversationMemories(database: Database, conversationId: number): MemoryCollectionView[] {
	const history = readSelectedHistory(database, conversationId);
	if (!history) return [];
	const db = drizzle(database);
	const activeVariants = new Set(db.select({ id: activeGenerationTable.variant_id }).from(activeGenerationTable).where(eq(activeGenerationTable.conversation_id, conversationId)).all().map((row) => row.id));
	const rows = db.select().from(memoryCollectionTable).where(eq(memoryCollectionTable.conversation_id, conversationId)).orderBy(asc(memoryCollectionTable.message_id)).all();
	const byVariant = new Map(rows.map((row) => [row.variant_id, row]));
	const sources = new Map<number, { messageId: number; variantId: number; selected: boolean }>();
	for (const message of history.messages) if (message.variant && !activeVariants.has(message.variant.id)) sources.set(message.variant.id, { messageId: message.id, variantId: message.variant.id, selected: true });
	for (const row of rows) if (!sources.has(row.variant_id) && !activeVariants.has(row.variant_id)) sources.set(row.variant_id, { messageId: row.message_id, variantId: row.variant_id, selected: false });
	const enabled = isMemoryEnabledForConversation(database, conversationId);
	return [...sources.values()].flatMap(({ messageId, variantId, selected }) => {
		if (activeVariants.has(variantId)) return [];
		const row = byVariant.get(variantId);
		const currentSource = db.select({ content: messageVariantTable.content }).from(messageVariantTable).innerJoin(messageTable, eq(messageVariantTable.message_id, messageTable.id)).where(and(eq(messageVariantTable.id, variantId), eq(messageTable.conversation_id, conversationId))).get();
		if (!currentSource) return [];
		if (!row && (selected && currentSource.content.trim().length === 0)) return [];
		if (!row) return [{ messageId, variantId, selected, status: "unprocessed" as const, error: null, revision: 0, ownership: "automatic" as const, sourceChanged: false, claims: [], indexing: { status: enabled ? "not-applicable" as const : "disabled" as const, pendingCount: 0, failedCount: 0, error: null } }];
		const sourceChanged = row.source_changed || sha256(currentSource.content) !== row.source_hash || (row.status === "failed" && Boolean(row.error?.startsWith("This source changed")));
		let claims: MemoryCandidateJudgment[] = [];
		try { claims = Value.Parse(memoryCandidates, JSON.parse(row.claims_json)); } catch { claims = []; }
		const ownership = memoryOwnership(row.ownership);
		const error = sourceChanged ? ownership === "writer" ? "This source changed. Automatic updates are paused for this writer-maintained collection." : row.error ?? "This source changed after its Memory collection was created." : row.error;
		return [{ messageId, variantId, selected, status: sourceChanged ? "stale" as const : collectionStatus(row.status), error, revision: row.revision, ownership, sourceChanged, claims: sourceChanged && ownership === "automatic" ? [] : claims, indexing: readMemoryIndexReadiness(database, row, enabled) }];
	});
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
		cancelMemoryIndexWork(database, variantId);
		db.update(memoryCollectionTable).set({ revision, ownership: "writer", status: "complete", error: null, claims_json: JSON.stringify(claims), work_epoch: row.work_epoch + 1, updated_at: new Date().toISOString() }).where(and(eq(memoryCollectionTable.variant_id, row.variant_id), eq(memoryCollectionTable.revision, row.revision))).run();
		queueMemoryIndexForVariant(database, variantId);
		const updated = db.select().from(memoryCollectionTable).where(eq(memoryCollectionTable.variant_id, variantId)).get();
		const corrected = view(claims, revision);
		return { ...corrected, indexing: updated ? readMemoryIndexReadiness(database, updated, isMemoryEnabledForConversation(database, conversationId)) : corrected.indexing, status: corrected.sourceChanged ? "stale" as const : "complete" as const, error: corrected.sourceChanged ? "This source changed. Automatic updates are paused for this writer-maintained collection." : null, ownership: "writer" as const };
	}).immediate();
}

export function retryMemorySourceIndex(database: Database, conversationId: number, messageId: number, variantId: number, expectedRevision: number): MemoryCollectionView {
	const current = readConversationMemories(database, conversationId).find((item) => item.variantId === variantId && item.messageId === messageId);
	if (!current) throw new InvalidMemorySourceError("This source has no saved Memory collection to index.");
	if (current.revision !== expectedRevision) throw new StaleMemoryCollectionError(current);
	try { retryMemoryIndexing(database, conversationId, variantId, expectedRevision); }
	catch (error) {
		if (error instanceof StaleMemoryIndexRevisionError) throw new StaleMemoryCollectionError(current);
		throw error;
	}
	return readConversationMemories(database, conversationId).find((item) => item.variantId === variantId && item.messageId === messageId) ?? current;
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
	if (automatic) cancelMemoryIndexWork(database, variantId);
	db.update(memoryCollectionTable).set({
		source_epoch: sql`${memoryCollectionTable.source_epoch} + 1`,
		work_epoch: sql`${memoryCollectionTable.work_epoch} + 1`,
		source_changed: true,
		status: "failed",
		error: "This source changed after its Memory collection was created. Reset and re-extract it to create a collection for the current source version.",
		updated_at: new Date().toISOString(),
	}).where(and(eq(memoryCollectionTable.variant_id, variantId), eq(memoryCollectionTable.ownership, "automatic"))).run();
	db.update(memoryCollectionTable).set({ source_epoch: sql`${memoryCollectionTable.source_epoch} + 1`, work_epoch: sql`${memoryCollectionTable.work_epoch} + 1`, source_changed: true, updated_at: new Date().toISOString() }).where(and(eq(memoryCollectionTable.variant_id, variantId), eq(memoryCollectionTable.ownership, "writer"))).run();
	if (automatic) {
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

export function startMemoryWorker(database: Database, options: MemoryWorkerOptions) {
	let stopped = false;
	const controller = new AbortController();
	const concurrency = Math.min(2, Math.max(1, options.concurrency ?? 2));
	const runOne = async () => {
		while (!stopped) {
			const next = database.transaction(() => {
				const db = drizzle(database);
				const extraction = db.select().from(memoryCollectionTable).where(eq(memoryCollectionTable.status, "pending")).orderBy(asc(memoryCollectionTable.catchup_run_id), asc(memoryCollectionTable.updated_at)).get();
				const indexing = db.select().from(memoryIndexWorkTable).where(eq(memoryIndexWorkTable.status, "pending")).orderBy(asc(memoryIndexWorkTable.updated_at)).get();
				const extractionPriority = extraction?.catchup_run_id === null ? 0 : 2;
				const indexingPriority = 1;
				if (extraction && (!indexing || extractionPriority < indexingPriority)) {
					const claimed = db.update(memoryCollectionTable).set({ status: "running", updated_at: new Date().toISOString() }).where(and(eq(memoryCollectionTable.variant_id, extraction.variant_id), eq(memoryCollectionTable.status, "pending"))).returning({ variantId: memoryCollectionTable.variant_id }).get();
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
				if (!job) continue;
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
				if (!source || !chat || !current || current.status !== "running" || current.revision !== job.revision || current.work_epoch !== job.work_epoch || current.source_epoch !== job.source_epoch || current.chat_epoch !== job.chat_epoch || current.ownership !== "automatic" || sha256(source.content) !== job.source_hash || !isMemoryEnabledForConversation(database, job.conversation_id)) {
					drizzle(database).update(memoryCollectionTable).set({ status: "failed", error: "This source or its Memory settings changed before extraction began. Reset and re-extract it when Memory is enabled.", updated_at: new Date().toISOString() }).where(and(eq(memoryCollectionTable.variant_id, job.variant_id), eq(memoryCollectionTable.status, "running"), eq(memoryCollectionTable.revision, job.revision), eq(memoryCollectionTable.work_epoch, job.work_epoch))).run();
					continue;
				}
				const snapshot = Value.Parse(memoryWorkSnapshot, JSON.parse(job.source_snapshot_json));
				const claims = await options.process(snapshot.source, snapshot.context, controller.signal, trace);
				database.transaction(() => {
					const finalSource = database.query<{ content: string }, [number, number]>("SELECT v.content FROM message_variant v JOIN messages m ON m.id=v.message_id WHERE v.id=? AND m.conversation_id=?").get(job.variant_id, job.conversation_id);
					const finalChat = drizzle(database).select().from(conversationMemorySettingsTable).where(eq(conversationMemorySettingsTable.conversation_id, job.conversation_id)).get();
					const finalCollection = drizzle(database).select().from(memoryCollectionTable).where(eq(memoryCollectionTable.variant_id, job.variant_id)).get();
					const currentHash = finalSource ? sha256(finalSource.content) : "";
					if (finalSource && finalChat && finalCollection && finalCollection.status === "running" && finalCollection.source_hash === currentHash && finalCollection.source_hash === job.source_hash && finalCollection.revision === job.revision && finalCollection.work_epoch === job.work_epoch && finalCollection.source_epoch === job.source_epoch && finalCollection.chat_epoch === finalChat.chat_epoch && finalCollection.chat_epoch === job.chat_epoch && finalCollection.ownership === "automatic" && isMemoryEnabledForConversation(database, job.conversation_id)) {
						drizzle(database).update(memoryCollectionTable).set({ status: "complete", claims_json: JSON.stringify(claims), provenance_json: JSON.stringify(claims.map(({ claim, attribution, evidence, judgment }) => ({ claim, attribution, evidence, judgment }))), error: null, updated_at: new Date().toISOString() }).where(and(eq(memoryCollectionTable.variant_id, job.variant_id), eq(memoryCollectionTable.revision, job.revision), eq(memoryCollectionTable.work_epoch, job.work_epoch), eq(memoryCollectionTable.source_epoch, job.source_epoch), eq(memoryCollectionTable.status, "running"), eq(memoryCollectionTable.ownership, "automatic"))).run();
						queueMemoryIndexForVariant(database, job.variant_id);
					}
				}).immediate();
			} catch (error) {
				if (stopped) continue;
				if (indexJob) { failMemoryIndexWork(database, indexJob, error instanceof Error ? error : new Error("Memory indexing failed.")); continue; }
				if (!job) continue;
				const message = error instanceof Error ? error.message.slice(0, 1024) : "Memory extraction failed.";
				trace("Failed", { error: message });
				drizzle(database).update(memoryCollectionTable).set({ status: "failed", error: message, updated_at: new Date().toISOString() }).where(and(eq(memoryCollectionTable.variant_id, job.variant_id), eq(memoryCollectionTable.revision, job.revision), eq(memoryCollectionTable.work_epoch, job.work_epoch), eq(memoryCollectionTable.status, "running"))).run();
			}
		}
	};
	drizzle(database).update(memoryCollectionTable).set({ status: "pending", updated_at: new Date().toISOString() }).where(eq(memoryCollectionTable.status, "running")).run();
	requeueInterruptedMemoryIndexWork(database);
	queueAllMemoryIndexing(database);
	const workers = Array.from({ length: concurrency }, runOne);
	return async () => { stopped = true; controller.abort(); await Promise.all(workers); };
}

export function readMemoryTrace(database: Database, conversationId: number, variantId: number): MemoryTraceStep[] {
	const row = drizzle(database).select({ trace: memoryCollectionTable.trace_json }).from(memoryCollectionTable).where(and(eq(memoryCollectionTable.variant_id, variantId), eq(memoryCollectionTable.conversation_id, conversationId))).get();
	return row?.trace ? Value.Parse(memoryTraceSteps, JSON.parse(row.trace)) : [];
}
