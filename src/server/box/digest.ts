import type { Database } from "bun:sqlite";
import { Value } from "@sinclair/typebox/value";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { type BoxCatchUp, type DigestBoxId } from "../../shared/contract/box";
import type { ConversationMemoryChange } from "../../shared/contract/conversation-memory-change";
import { readSelectedPathForMemory, readVariantsForMemory } from "../conversation";
import { decisionRequest, requestDecisions } from "../decision-model";
import { sha256 } from "../memory/hash";
import type { ModelFetch } from "../model-client/types";
import { resolveBoxDecision } from "./decision-settings";
import { hasAutomaticRecord, readRecordSlots, readVariantSeeds, writeAutomaticRecord } from "./records";
import { isBoxEnabled, readBoxInstances } from "./setup";
import { boxSeed, variantSeedOf } from "./seed";
import { worldClockBox } from "./world-clock";

// @approved
//  The host digest queue (ADR-0050). Selected passages are digested in the
// background by at most two workers; Generations never wait for them. A newer
// job for the same Variant and Box raises its epoch, which aborts the older
// one and discards its result. A catch-up run queues every selected Variant
// without a record behind live work and reports its progress to the window.
// Jobs live in memory: work lost on restart is picked up when the passage is
// next selected, resolved or edited, or by another catch-up run.

interface CatchUpRun {
	readonly conversationId: number;
	readonly total: number;
	remaining: number;
}

interface DigestJob {
	readonly conversationId: number;
	readonly messageId: number;
	readonly variantId: number;
	readonly box: DigestBoxId;
	/** @approved The Box instance the job writes its record for, read when it was queued. */
	readonly instance: string;
	readonly source: string;
	readonly epoch: number;
	readonly catchUp: CatchUpRun | null;
	settled: boolean;
}

interface DigestQueue {
	readonly fetch: ModelFetch | undefined;
	readonly pending: DigestJob[];
	catchUpPending: DigestJob[];
	readonly epochs: Map<string, number>;
	readonly running: Map<string, { readonly conversationId: number; readonly controller: AbortController; readonly source: string; readonly catchUp: CatchUpRun | null }>;
	readonly catchUps: Map<number, CatchUpRun>;
	readonly workers: Set<Promise<void>>;
	stopped: boolean;
}

const WORKERS = 2;
const queues = new WeakMap<Database, DigestQueue>();
const keyOf = (variantId: number, box: DigestBoxId) => `${variantId}:${box}`;

// @approved
//  A catch-up job leaves its run exactly once, whether it finished, was
//  superseded, or lost to cancellation. `remaining` drives the window's
//  progress and the run disappears from the queue when nothing is left.
const settleCatchUp = (queue: DigestQueue, job: DigestJob): void => {
	if (job.settled) return;
	job.settled = true;
	const run = job.catchUp;
	if (run === null || queue.catchUps.get(run.conversationId) !== run) return;
	run.remaining -= 1;
	if (run.remaining === 0) queue.catchUps.delete(run.conversationId);
};

const supersede = (queue: DigestQueue, key: string): number => {
	const epoch = (queue.epochs.get(key) ?? 0) + 1;
	queue.epochs.set(key, epoch);
	queue.running.get(key)?.controller.abort();
	for (const pending of [queue.pending, queue.catchUpPending]) {
		const index = pending.findIndex((job) => keyOf(job.variantId, job.box) === key);
		if (index !== -1) settleCatchUp(queue, pending.splice(index, 1)[0]);
	}
	return epoch;
};

const runDigest = async (database: Database, queue: DigestQueue, job: DigestJob): Promise<void> => {
	const key = keyOf(job.variantId, job.box);
	const controller = new AbortController();
	const running = { conversationId: job.conversationId, controller, source: job.source, catchUp: job.catchUp };
	queue.running.set(key, running);
	const box = worldClockBox;
	try {
		if (!isBoxEnabled(drizzle(database), job.conversationId, job.box)) return;
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
		const enabled = isBoxEnabled(drizzle(database), job.conversationId, job.box);
		const catchUpActive = job.catchUp === null || queue.catchUps.get(job.conversationId) === job.catchUp;
		if (settled && catchUpActive && enabled && resolveBoxDecision(database, job.box).kind === "ready") writeAutomaticRecord(drizzle(database), job.box, job.instance, job.variantId, record, job.source);
	} catch (error) {
		if (!controller.signal.aborted) console.error(`[box-digest] The ${job.box} digest of Variant ${job.variantId} failed.`, error);
	} finally {
		if (queue.running.get(key) === running) queue.running.delete(key);
		settleCatchUp(queue, job);
	}
};

// @approved
//  Live jobs keep their place ahead of every catch-up job: the queue drains
//  `pending` before it touches `catchUpPending`.
const pump = (database: Database, queue: DigestQueue): void => {
	while (!queue.stopped && queue.workers.size < WORKERS) {
		const job = queue.pending.shift() ?? queue.catchUpPending.shift();
		if (job === undefined) return;
		const worker = runDigest(database, queue, job).finally(() => {
			queue.workers.delete(worker);
			pump(database, queue);
		});
		queue.workers.add(worker);
	}
};

export function startBoxDigests(database: Database, options: { fetch?: ModelFetch | undefined } = {}): () => Promise<void> {
	const queue: DigestQueue = { fetch: options.fetch, pending: [], catchUpPending: [], epochs: new Map(), running: new Map(), catchUps: new Map(), workers: new Set(), stopped: false };
	queues.set(database, queue);
	return async () => {
		queue.stopped = true;
		queue.pending.length = 0;
		queue.catchUpPending.length = 0;
		queue.catchUps.clear();
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
	if (change.stoppedBox === "world-clock") {
		// @approved
		//  A clock that stops running abandons its Chat's work: raising each
		//  epoch aborts requests in flight and discards any late result, and
		//  releasing their running entries lets the same passages queue again.
		const keys = new Set([...queue.pending, ...queue.catchUpPending].flatMap((job) => job.conversationId === change.conversationId ? [keyOf(job.variantId, job.box)] : []));
		for (const [key, running] of queue.running) if (running.conversationId === change.conversationId) keys.add(key);
		for (const key of keys) {
			supersede(queue, key);
			queue.running.delete(key);
		}
		queue.catchUps.delete(change.conversationId);
	}
	for (const variantId of change.removedVariantIds) supersede(queue, keyOf(variantId, "world-clock"));
	if (change.touchedVariantIds.length === 0) return;
	if (!isBoxEnabled(drizzle(database), change.conversationId, "world-clock")) return;
	if (resolveBoxDecision(database, "world-clock").kind !== "ready") return;
	const instance = readBoxInstances(drizzle(database), change.conversationId)["world-clock"];
	if (instance === undefined) return;
	const variants = readVariantsForMemory(database, change.conversationId, { variantIds: change.touchedVariantIds, includeActive: true })
		.filter((variant) => variant.selected && !variant.active && variant.content.trim() !== "");
	const slots = readRecordSlots(drizzle(database), "world-clock", instance, variants.map((variant) => variant.variantId));
	for (const variant of variants) {
		const source = sha256(variant.content);
		const key = keyOf(variant.variantId, "world-clock");
		// @approved
		//  A live job counts only live work as already queued: a running or
		//  pending catch-up job for the same text is superseded by pushing it,
		//  so live work keeps its place ahead of a catch-up run.
		const running = queue.running.get(key);
		const queued = (running !== undefined && running.catchUp === null && running.source === source)
			|| queue.pending.some((job) => keyOf(job.variantId, job.box) === key && job.source === source);
		if (hasAutomaticRecord(slots.get(variant.variantId), variant.content) || queued) continue;
		queue.pending.push({
			conversationId: change.conversationId, messageId: variant.messageId, variantId: variant.variantId,
			box: "world-clock", instance, source, epoch: supersede(queue, key), catchUp: null, settled: false,
		});
	}
	queueMicrotask(() => pump(database, queue));
}

/** @approved The window's live view of one Conversation's catch-up run, or null when none runs. */
export function readBoxCatchUp(database: Database, conversationId: number): BoxCatchUp | null {
	const run = queues.get(database)?.catchUps.get(conversationId);
	return run === undefined ? null : { total: run.total, remaining: run.remaining };
}

// @approved
//  Starts one catch-up run over the Selected path: every selected Variant
//  without a record for its current text is queued behind live work. A run
//  already in flight is left alone, so a second request is a no-op.
export function startBoxCatchUp(database: Database, conversationId: number): void {
	const queue = queues.get(database);
	if (queue === undefined || queue.stopped || queue.catchUps.has(conversationId)) return;
	if (!isBoxEnabled(drizzle(database), conversationId, "world-clock")) return;
	if (resolveBoxDecision(database, "world-clock").kind !== "ready") return;
	const instance = readBoxInstances(drizzle(database), conversationId)["world-clock"];
	const path = readSelectedPathForMemory(database, conversationId);
	if (path === undefined || instance === undefined) return;
	const variants = path.flatMap((message) => message.variant === null || message.variant.active || message.variant.content.trim() === "" ? [] : [message.variant]);
	const slots = readRecordSlots(drizzle(database), "world-clock", instance, variants.map((variant) => variant.variantId));
	const missing = variants.filter((variant) => {
		const source = sha256(variant.content);
		const key = keyOf(variant.variantId, "world-clock");
		const running = queue.running.get(key);
		return !hasAutomaticRecord(slots.get(variant.variantId), variant.content)
			&& !(running !== undefined && running.catchUp === null && running.source === source)
			&& !queue.pending.some((job) => keyOf(job.variantId, job.box) === key && job.source === source)
			&& !queue.catchUpPending.some((job) => keyOf(job.variantId, job.box) === key && job.source === source);
	});
	if (missing.length === 0) return;
	const run: CatchUpRun = { conversationId, total: missing.length, remaining: missing.length };
	queue.catchUps.set(conversationId, run);
	for (const variant of missing) {
		const key = keyOf(variant.variantId, "world-clock");
		queue.catchUpPending.push({
			conversationId, messageId: variant.messageId, variantId: variant.variantId,
			box: "world-clock", instance, source: sha256(variant.content), epoch: supersede(queue, key), catchUp: run, settled: false,
		});
	}
	queueMicrotask(() => pump(database, queue));
}

// @approved
//  Cancels one catch-up run: its queued jobs are dropped, its in-flight
//  requests are aborted, and their running entries are released immediately
//  so an aborted Variant can be queued again. No late result lands. Live
//  digest work for the same Variants is untouched.
export function cancelBoxCatchUp(database: Database, conversationId: number): void {
	const queue = queues.get(database);
	const run = queue?.catchUps.get(conversationId);
	if (queue === undefined || run === undefined) return;
	queue.catchUps.delete(conversationId);
	queue.catchUpPending = queue.catchUpPending.filter((job) => job.catchUp !== run);
	for (const [key, running] of queue.running) {
		if (running.catchUp !== run) continue;
		queue.running.delete(key);
		running.controller.abort();
	}
}
