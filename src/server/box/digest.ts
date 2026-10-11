import type { Database } from "bun:sqlite";
import { Value } from "@sinclair/typebox/value";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { DigestBoxId } from "../../shared/contract/box";
import type { ConversationMemoryChange } from "../../shared/contract/conversation-memory-change";
import { readSelectedPathForMemory, readVariantsForMemory } from "../conversation";
import { decisionRequest, requestDecisions } from "../decision-model";
import { sha256 } from "../memory/hash";
import type { ModelFetch } from "../model-client/types";
import { resolveBoxDecision } from "./decision-settings";
import { readRecordSlots, readVariantSeeds, recordBoxes, writeAutomaticRecord } from "./records";
import { readBoxSetups } from "./setup";
import { boxSeed, variantSeedOf } from "./seed";

// @approved
//  The host digest queue (ADR-0050). Selected passages are digested in the
// background by at most two workers; Generations never wait for them. A newer
// job for the same Variant and Box raises its epoch, which aborts the older
// one and discards its result. Jobs live in memory: work lost on restart is
// picked up when the passage is next selected, resolved or edited.

interface DigestJob {
	readonly conversationId: number;
	readonly messageId: number;
	readonly variantId: number;
	readonly box: DigestBoxId;
	readonly source: string;
	readonly epoch: number;
}

interface DigestQueue {
	readonly fetch: ModelFetch | undefined;
	readonly pending: DigestJob[];
	readonly epochs: Map<string, number>;
	readonly running: Map<string, { readonly controller: AbortController; readonly source: string }>;
	readonly workers: Set<Promise<void>>;
	stopped: boolean;
}

const WORKERS = 2;
const queues = new WeakMap<Database, DigestQueue>();
const keyOf = (variantId: number, box: DigestBoxId) => `${variantId}:${box}`;

const supersede = (queue: DigestQueue, key: string): number => {
	const epoch = (queue.epochs.get(key) ?? 0) + 1;
	queue.epochs.set(key, epoch);
	queue.running.get(key)?.controller.abort();
	const index = queue.pending.findIndex((job) => keyOf(job.variantId, job.box) === key);
	if (index !== -1) queue.pending.splice(index, 1);
	return epoch;
};

const runDigest = async (database: Database, queue: DigestQueue, job: DigestJob): Promise<void> => {
	const key = keyOf(job.variantId, job.box);
	const controller = new AbortController();
	const running = { controller, source: job.source };
	queue.running.set(key, running);
	const box = recordBoxes[job.box];
	try {
		if (!readBoxSetups(drizzle(database), job.conversationId)[job.box].enabled) return;
		const decision = resolveBoxDecision(database, job.box);
		if (decision.kind !== "ready") return;
		const path = readSelectedPathForMemory(database, job.conversationId, job.messageId) ?? [];
		const index = path.findIndex((message) => message.variant?.variantId === job.variantId);
		const variant = path[index]?.variant;
		if (variant === undefined || variant === null || variant.active || sha256(variant.content) !== job.source) return;
		const preceding = path.slice(0, index).flatMap((message) => message.variant === null ? [] : [{ speaker: message.author, content: message.variant.content }]).slice(-box.records.digest.window);
		const seed = boxSeed(variantSeedOf(readVariantSeeds(drizzle(database), [job.variantId]).get(job.variantId), job.variantId), job.box);
		const record = await box.records.digest.run({ passage: { speaker: variant.speaker, content: variant.content }, preceding, seed }, {
			signal: controller.signal,
			decide: (state, questions) => {
				const { request, fits } = decisionRequest(decision.decision, state, questions);
				if (!fits) throw new Error("The passage exceeds the Decision Model's state token limit.");
				return requestDecisions({ request, questions, selection: decision.decision, fetch: queue.fetch, signal: controller.signal });
			},
		});
		Value.Assert(box.records.schema, record);
		// @approved
		//  The text may have been edited back to an already-digested version, or
		// the selection cleared, while the request ran; neither raises the epoch.
		const current = readVariantsForMemory(database, job.conversationId, { variantIds: [job.variantId], includeActive: true })[0];
		const settled = queue.epochs.get(key) === job.epoch && current !== undefined && sha256(current.content) === job.source;
		const enabled = readBoxSetups(drizzle(database), job.conversationId)[job.box].enabled;
		if (settled && enabled && resolveBoxDecision(database, job.box).kind === "ready") writeAutomaticRecord(drizzle(database), job.box, job.variantId, record, job.source);
	} catch (error) {
		if (!controller.signal.aborted) console.error(`[box-digest] The ${job.box} digest of Variant ${job.variantId} failed.`, error);
	} finally {
		if (queue.running.get(key) === running) queue.running.delete(key);
	}
};

const pump = (database: Database, queue: DigestQueue): void => {
	while (!queue.stopped && queue.workers.size < WORKERS && queue.pending.length > 0) {
		const worker = runDigest(database, queue, queue.pending.shift()!).finally(() => {
			queue.workers.delete(worker);
			pump(database, queue);
		});
		queue.workers.add(worker);
	}
};

export function startBoxDigests(database: Database, options: { fetch?: ModelFetch | undefined } = {}): () => Promise<void> {
	const queue: DigestQueue = { fetch: options.fetch, pending: [], epochs: new Map(), running: new Map(), workers: new Set(), stopped: false };
	queues.set(database, queue);
	return async () => {
		queue.stopped = true;
		queue.pending.length = 0;
		for (const { controller } of queue.running.values()) controller.abort();
		await Promise.all(queue.workers);
		queues.delete(database);
	};
}

// @approved
//  Queue digests for one Conversation write. A selected, settled passage is
// digested when it has no record for its current text: when it resolves, is
// selected without a record, or is edited. Runs inside the write transaction,
// so the workers start only after it commits.
export function queueBoxDigests(database: Database, change: ConversationMemoryChange): void {
	const queue = queues.get(database);
	if (queue === undefined) return;
	for (const variantId of change.removedVariantIds) supersede(queue, keyOf(variantId, "world-clock"));
	if (change.touchedVariantIds.length === 0) return;
	if (!readBoxSetups(drizzle(database), change.conversationId)["world-clock"].enabled) return;
	if (resolveBoxDecision(database, "world-clock").kind !== "ready") return;
	const variants = readVariantsForMemory(database, change.conversationId, { variantIds: change.touchedVariantIds, includeActive: true })
		.filter((variant) => variant.selected && !variant.active && variant.content.trim() !== "");
	const slots = readRecordSlots(drizzle(database), "world-clock", variants.map((variant) => variant.variantId));
	for (const variant of variants) {
		const source = sha256(variant.content);
		const key = keyOf(variant.variantId, "world-clock");
		const queued = queue.running.get(key)?.source === source || queue.pending.some((job) => keyOf(job.variantId, job.box) === key && job.source === source);
		if (slots.get(variant.variantId)?.source === source || queued) continue;
		queue.pending.push({ conversationId: change.conversationId, messageId: variant.messageId, variantId: variant.variantId, box: "world-clock", source, epoch: supersede(queue, key) });
	}
	queueMicrotask(() => pump(database, queue));
}
