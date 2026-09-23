import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { readConversationPromptPreset } from "../conversation/prompt-preset";
import { readSelectedHistory } from "../conversation/selected-history";
import { conversationMemorySettingsTable, memoryCollectionTable, messageTable, messageVariantTable } from "../database/schema";
import type { MemoryCandidateJudgment, CapturedMemoryMessage } from "./extraction";
import { Value } from "@sinclair/typebox/value";
import { memoryCandidates, memoryWorkSnapshot } from "../../shared/contract/memory";

export interface MemoryCollectionView {
	messageId: number;
	variantId: number;
	status: "unprocessed" | "stale" | "pending" | "running" | "complete" | "failed";
	error: string | null;
	revision: number;
	ownership: "automatic" | "writer";
	claims: MemoryCandidateJudgment[];
}

export class InvalidMemorySourceError extends Error {
	constructor(message: string) { super(message); this.name = "InvalidMemorySourceError"; }
}

const hash = (content: string) => createHash("sha256").update(content, "utf8").digest("hex");
const collectionStatus = (value: string): MemoryCollectionView["status"] => {
	if (value === "pending" || value === "running" || value === "complete" || value === "failed") return value;
	throw new Error("Memory collection has an invalid processing status.");
};
const collectionOwnership = (value: string): MemoryCollectionView["ownership"] => {
	if (value === "automatic" || value === "writer") return value;
	throw new Error("Memory collection has an invalid ownership state.");
};
const memoryEnabled = (database: Database, conversationId: number) =>
	readConversationPromptPreset(database, conversationId)?.slots.some((slot) => slot.reference === "memory" && slot.enabled) ?? false;

const capture = (database: Database, conversationId: number, messageId: number) => {
	const selected = readSelectedHistory(database, conversationId, { targetMessageId: messageId });
	if (!selected?.target) throw new InvalidMemorySourceError("This source no longer belongs to the selected Chat.");
	const variant = selected.target.variant;
	if (!variant) throw new InvalidMemorySourceError("Memory can only process a retained selected Variant.");
	if (variant.content.trim().length === 0) throw new InvalidMemorySourceError("Empty sources are not processed. Save nonempty story content first.");
	const previous = selected.messages.filter((message) => message.variant).slice(-4);
	const source: CapturedMemoryMessage = { messageId, variantId: variant.id, content: variant.content };
	const context = previous.map((message) => ({ messageId: message.id, variantId: message.variant!.id, content: message.variant!.content }));
	return { source, context, sourceHash: hash(source.content) };
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
		if (!memoryEnabled(database, conversationId)) throw new InvalidMemorySourceError("Enable Memory in the selected Prompt Preset before remembering a source.");
		const captured = capture(database, conversationId, messageId);
		const chat = ensureChatState(database, conversationId);
		const current = db.select().from(memoryCollectionTable).where(eq(memoryCollectionTable.variant_id, captured.source.variantId)).get();
		const now = new Date().toISOString();
		const revision = (current?.revision ?? 0) + 1;
		const workEpoch = (current?.work_epoch ?? 0) + 1;
		const sourceEpoch = (current?.source_epoch ?? 0) + 1;
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
			status: "pending",
			error: null,
			source_snapshot_json: sourceSnapshot,
			claims_json: "[]",
			provenance_json: "[]",
			updated_at: now,
		}).onConflictDoUpdate({
			target: memoryCollectionTable.variant_id,
			set: {
				conversation_id: conversationId, message_id: messageId, source_hash: captured.sourceHash,
				revision, ownership: "automatic", work_epoch: workEpoch, source_epoch: sourceEpoch, chat_epoch: chat.chat_epoch,
				status: "pending", error: null, source_snapshot_json: sourceSnapshot,
				claims_json: "[]", provenance_json: "[]", updated_at: now,
			},
		}).run();
		return {
			messageId, variantId: captured.source.variantId, status: "pending" as const, error: null,
			revision, ownership: "automatic" as const, claims: [],
		};
	}).immediate();
}

export function readConversationMemories(database: Database, conversationId: number): MemoryCollectionView[] {
	const history = readSelectedHistory(database, conversationId);
	if (!history) return [];
	const selectedVariants = history.messages.flatMap((message) => message.variant ? [{ messageId: message.id, variantId: message.variant.id }] : []);
	if (!selectedVariants.length) return [];
	const db = drizzle(database);
	const rows = db.select().from(memoryCollectionTable).where(eq(memoryCollectionTable.conversation_id, conversationId)).orderBy(asc(memoryCollectionTable.message_id)).all();
	const byVariant = new Map(rows.map((row) => [row.variant_id, row]));
	return selectedVariants.flatMap(({ messageId, variantId }) => {
		const row = byVariant.get(variantId);
		const currentSource = db.select({ content: messageVariantTable.content }).from(messageVariantTable).innerJoin(messageTable, eq(messageVariantTable.message_id, messageTable.id)).where(and(eq(messageVariantTable.id, variantId), eq(messageTable.conversation_id, conversationId), eq(messageVariantTable.selected, true))).get();
		if (!currentSource || currentSource.content.trim().length === 0) return [];
		if (!row) return [{ messageId, variantId, status: "unprocessed" as const, error: null, revision: 0, ownership: "automatic" as const, claims: [] }];
		if (hash(currentSource.content) !== row.source_hash || (row.status === "failed" && row.error?.startsWith("This source changed"))) return [{ messageId, variantId, status: "stale" as const, error: row.error ?? "This source changed after its Memory collection was created.", revision: row.revision, ownership: collectionOwnership(row.ownership), claims: [] }];
		let claims: MemoryCandidateJudgment[] = [];
		try { claims = Value.Parse(memoryCandidates, JSON.parse(row.claims_json)); } catch { claims = []; }
		return [{ messageId, variantId, status: collectionStatus(row.status), error: row.error, revision: row.revision, ownership: collectionOwnership(row.ownership), claims }];
	});
}

export class StaleMemoryAllowanceError extends Error {
	constructor(readonly expectedRevision: number, readonly actualRevision: number, readonly currentSettings: { revision: number; allowance: number; enabled: boolean }) {
		super("Memory Allowance changed in another session.");
		this.name = "StaleMemoryAllowanceError";
	}
}

// ==[HUMAN APPROVED]== Invalidate one source version whenever its text or selected status changes.
export function invalidateMemoryWorkForVariant(database: Database, variantId: number) {
	drizzle(database).update(memoryCollectionTable).set({
		source_epoch: sql`${memoryCollectionTable.source_epoch} + 1`,
		work_epoch: sql`${memoryCollectionTable.work_epoch} + 1`,
		status: "failed",
		error: "This source changed after its Memory collection was created. Reset and re-extract it to create a collection for the current source version.",
		updated_at: new Date().toISOString(),
	}).where(eq(memoryCollectionTable.variant_id, variantId)).run();
}

export function readMemoryAllowance(database: Database, conversationId: number) {
	const state = ensureChatState(database, conversationId);
	return { revision: state.revision, allowance: state.allowance, enabled: memoryEnabled(database, conversationId) };
}

export function setMemoryAllowance(database: Database, conversationId: number, expectedRevision: number, allowance: number) {
	if (!Number.isSafeInteger(allowance) || allowance < 0) throw new InvalidMemorySourceError("Memory Allowance must be a non-negative whole number of estimated tokens.");
	return database.transaction(() => {
		const current = ensureChatState(database, conversationId);
		if (current.revision !== expectedRevision) throw new StaleMemoryAllowanceError(expectedRevision, current.revision, { revision: current.revision, allowance: current.allowance, enabled: memoryEnabled(database, conversationId) });
		const next = current.revision + 1;
		drizzle(database).update(conversationMemorySettingsTable).set({ allowance, revision: next }).where(eq(conversationMemorySettingsTable.conversation_id, conversationId)).run();
		return { revision: next, allowance, enabled: memoryEnabled(database, conversationId) };
	}).immediate();
}

export interface MemoryExtractionWorkerOptions {
	process: (source: CapturedMemoryMessage, context: readonly CapturedMemoryMessage[], signal: AbortSignal) => Promise<MemoryCandidateJudgment[]>;
	concurrency?: number;
}

export function startMemoryExtractionWorker(database: Database, options: MemoryExtractionWorkerOptions) {
	let stopped = false;
	const controller = new AbortController();
	const concurrency = Math.min(2, Math.max(1, options.concurrency ?? 2));
	const runOne = async () => {
		while (!stopped) {
			const job = database.transaction(() => {
				const db = drizzle(database);
				const pending = db.select().from(memoryCollectionTable).where(eq(memoryCollectionTable.status, "pending")).orderBy(asc(memoryCollectionTable.updated_at)).get();
				if (!pending) return undefined;
				db.update(memoryCollectionTable).set({ status: "running", updated_at: new Date().toISOString() }).where(and(eq(memoryCollectionTable.variant_id, pending.variant_id), eq(memoryCollectionTable.status, "pending"))).run();
				return { ...pending, status: "running" as const };
			}).immediate();
			if (!job) { await new Promise((resolve) => setTimeout(resolve, 300)); continue; }
			try {
				const source = database.query<{ content: string }, [number, number]>("SELECT v.content FROM message_variant v JOIN messages m ON m.id=v.message_id WHERE v.id=? AND m.conversation_id=?").get(job.variant_id, job.conversation_id);
				const chat = drizzle(database).select().from(conversationMemorySettingsTable).where(eq(conversationMemorySettingsTable.conversation_id, job.conversation_id)).get();
				const current = drizzle(database).select().from(memoryCollectionTable).where(eq(memoryCollectionTable.variant_id, job.variant_id)).get();
				if (!source || !chat || !current || current.status !== "running" || current.revision !== job.revision || current.work_epoch !== job.work_epoch || current.source_epoch !== job.source_epoch || current.chat_epoch !== job.chat_epoch || current.ownership !== "automatic" || hash(source.content) !== job.source_hash || !memoryEnabled(database, job.conversation_id)) {
					drizzle(database).update(memoryCollectionTable).set({ status: "failed", error: "This source or its Memory settings changed before extraction began. Reset and re-extract it when Memory is enabled.", updated_at: new Date().toISOString() }).where(and(eq(memoryCollectionTable.variant_id, job.variant_id), eq(memoryCollectionTable.status, "running"), eq(memoryCollectionTable.revision, job.revision), eq(memoryCollectionTable.work_epoch, job.work_epoch))).run();
					continue;
				}
				const snapshot = Value.Parse(memoryWorkSnapshot, JSON.parse(job.source_snapshot_json));
				const claims = await options.process(snapshot.source, snapshot.context, controller.signal);
				const finalSource = database.query<{ content: string }, [number, number]>("SELECT v.content FROM message_variant v JOIN messages m ON m.id=v.message_id WHERE v.id=? AND m.conversation_id=?").get(job.variant_id, job.conversation_id);
				const finalChat = drizzle(database).select().from(conversationMemorySettingsTable).where(eq(conversationMemorySettingsTable.conversation_id, job.conversation_id)).get();
				const finalCollection = drizzle(database).select().from(memoryCollectionTable).where(eq(memoryCollectionTable.variant_id, job.variant_id)).get();
				const currentHash = finalSource ? hash(finalSource.content) : "";
				if (finalSource && finalChat && finalCollection && finalCollection.status === "running" && finalCollection.source_hash === currentHash && finalCollection.source_hash === job.source_hash && finalCollection.revision === job.revision && finalCollection.work_epoch === job.work_epoch && finalCollection.source_epoch === job.source_epoch && finalCollection.chat_epoch === finalChat.chat_epoch && finalCollection.chat_epoch === job.chat_epoch && finalCollection.ownership === "automatic" && memoryEnabled(database, job.conversation_id)) {
					drizzle(database).update(memoryCollectionTable).set({ status: "complete", claims_json: JSON.stringify(claims), provenance_json: JSON.stringify(claims.map(({ claim, attribution, evidence, judgment }) => ({ claim, attribution, evidence, judgment }))), error: null, updated_at: new Date().toISOString() }).where(eq(memoryCollectionTable.variant_id, job.variant_id)).run();
				}
			} catch (error) {
				if (stopped) continue;
				const message = error instanceof Error ? error.message.slice(0, 1024) : "Memory extraction failed.";
				drizzle(database).update(memoryCollectionTable).set({ status: "failed", error: message, updated_at: new Date().toISOString() }).where(and(eq(memoryCollectionTable.variant_id, job.variant_id), eq(memoryCollectionTable.revision, job.revision), eq(memoryCollectionTable.work_epoch, job.work_epoch), eq(memoryCollectionTable.status, "running"))).run();
			}
		}
	};
	drizzle(database).update(memoryCollectionTable).set({ status: "pending", updated_at: new Date().toISOString() }).where(eq(memoryCollectionTable.status, "running")).run();
	const workers = Array.from({ length: concurrency }, runOne);
	return async () => { stopped = true; controller.abort(); await Promise.all(workers); };
}
