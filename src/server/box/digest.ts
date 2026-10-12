import type { Database } from "bun:sqlite";
import { Value } from "@sinclair/typebox/value";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { boxDescriptors, digestBoxIds, type BoxDescriptors, type BoxId, type BoxSetups, type DigestBoxId } from "../../shared/contract/box";
import type { BoxCatchUp, DigestRead } from "../../shared/contract/box-digest";
import type { ConversationMemoryChange } from "../../shared/contract/conversation-memory-change";
import {
	readConversationSummaryFromConnection, readSelectedHistoryFromConnection, readSelectedPathForMemory,
	readSelectedVariantIdsFromConnection, readVariantsForMemory, runConversationReadTransaction,
} from "../conversation";
import { decisionRequest, requestDecisions } from "../decision-model";
import { sha256 } from "../memory/hash";
import type { ModelFetch } from "../model-client/types";
import { resolveBoxDecision } from "./decision-settings";
import { effectiveRecord, foldRecords, hasAutomaticRecord, readRecordSlots, readVariantSeeds, writeAutomaticRecord } from "./records";
import { serverBox } from "./registry";
import { isBoxEnabled, readBoxInstances } from "./setup";
import { boxSeed, variantSeedOf } from "./seed";

// @approved
//  The host digest queue (ADR-0050). Selected passages are digested in the
// background by at most two workers; Generations never wait for them. A newer
// job for the same Variant and Box raises its epoch, which aborts the older
// one and discards its result. A catch-up run queues one Box's selected
// Variants without a record behind live work and reports its progress to the
// Box's window.
// Jobs live in memory: work lost on restart is picked up when the passage is
// next selected, resolved or edited, or by another catch-up run.

interface CatchUpRun {
	readonly key: string;
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
	readonly running: Map<string, { readonly conversationId: number; readonly box: DigestBoxId; readonly controller: AbortController; readonly source: string; readonly catchUp: CatchUpRun | null }>;
	readonly catchUps: Map<string, CatchUpRun>;
	readonly workers: Set<Promise<void>>;
	stopped: boolean;
}

const WORKERS = 2;
const queues = new WeakMap<Database, DigestQueue>();
const keyOf = (variantId: number, box: DigestBoxId) => `${variantId}:${box}`;
const catchUpKey = (conversationId: number, box: BoxId) => `${conversationId}:${box}`;

// @approved
//  A catch-up job leaves its run exactly once, whether it finished, was
//  superseded, or lost to cancellation. `remaining` drives the window's
//  progress and the run disappears from the queue when nothing is left.
const settleCatchUp = (queue: DigestQueue, job: DigestJob): void => {
	if (job.settled) return;
	job.settled = true;
	const run = job.catchUp;
	if (run === null || queue.catchUps.get(run.key) !== run) return;
	run.remaining -= 1;
	if (run.remaining === 0) queue.catchUps.delete(run.key);
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
	const running = { conversationId: job.conversationId, box: job.box, controller, source: job.source, catchUp: job.catchUp };
	queue.running.set(key, running);
	const { digest } = serverBox(job.box).records;
	try {
		if (!isBoxEnabled(drizzle(database), job.conversationId, job.box)) return;
		const decision = resolveBoxDecision(database, job.box);
		if (decision.kind !== "ready") return;
		const path = readSelectedPathForMemory(database, job.conversationId, job.messageId) ?? [];
		const index = path.findIndex((message) => message.variant?.variantId === job.variantId);
		const variant = path[index]?.variant;
		if (variant === undefined || variant === null || variant.active || sha256(variant.content) !== job.source) return;
		const preceding = path.slice(0, index).flatMap((message) => message.variant === null ? [] : [{ speaker: message.author, content: message.variant.content }]).slice(-digest.window);
		const seed = boxSeed(variantSeedOf(readVariantSeeds(drizzle(database), [job.variantId]).get(job.variantId), job.variantId), job.box);
		const record = await digest.run({ passage: { speaker: variant.speaker, content: variant.content }, preceding, seed }, {
			signal: controller.signal,
			decide: (state, questions) => {
				const { request, fits } = decisionRequest(decision.decision, state, questions);
				if (!fits) throw new Error("The passage exceeds the Decision Model's state token limit.");
				return requestDecisions({ request, questions, selection: decision.decision, fetch: queue.fetch, signal: controller.signal });
			},
		});
		Value.Assert(boxDescriptors[job.box].record, record);
		// @approved
		//  The text may have been edited back to an already-digested version, or
		// the selection cleared, while the request ran; neither raises the epoch.
		const current = readVariantsForMemory(database, job.conversationId, { variantIds: [job.variantId], includeActive: true })[0];
		const settled = queue.epochs.get(key) === job.epoch && current !== undefined && sha256(current.content) === job.source;
		const enabled = isBoxEnabled(drizzle(database), job.conversationId, job.box);
		const catchUpActive = job.catchUp === null || queue.catchUps.get(job.catchUp.key) === job.catchUp;
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
//  The instance a Box digests for in this Chat, or undefined when it may not
// digest: it must be enabled and have its Decision Model selected.
const digestInstance = (database: Database, conversationId: number, box: DigestBoxId): string | undefined =>
	isBoxEnabled(drizzle(database), conversationId, box) && resolveBoxDecision(database, box).kind === "ready"
		? readBoxInstances(drizzle(database), conversationId)[box]
		: undefined;

// @approved
//  A Box that stops running abandons its Chat's work: raising each epoch
// aborts requests in flight and discards any late result, and releasing their
// running entries lets the same passages queue again.
const abandon = (queue: DigestQueue, conversationId: number, box: BoxId): void => {
	const ours = (job: { readonly conversationId: number; readonly box: DigestBoxId }) => job.conversationId === conversationId && job.box === box;
	const keys = new Set([...queue.pending, ...queue.catchUpPending].flatMap((job) => ours(job) ? [keyOf(job.variantId, job.box)] : []));
	for (const [key, running] of queue.running) if (ours(running)) keys.add(key);
	for (const key of keys) {
		supersede(queue, key);
		queue.running.delete(key);
	}
	queue.catchUps.delete(catchUpKey(conversationId, box));
};

// @approved
//  Queue digests for one Conversation write. A selected, settled passage is
// digested by each digesting Box when it has no record for its current text:
// when it resolves, is selected without a record, or is edited. Runs inside
// the write transaction, so the workers start only after it commits.
export function queueBoxDigests(database: Database, change: ConversationMemoryChange): void {
	const queue = queues.get(database);
	if (queue === undefined) return;
	if (change.stoppedBox !== undefined) abandon(queue, change.conversationId, change.stoppedBox);
	for (const box of digestBoxIds) {
		for (const variantId of change.removedVariantIds) supersede(queue, keyOf(variantId, box));
		const instance = change.touchedVariantIds.length === 0 ? undefined : digestInstance(database, change.conversationId, box);
		if (instance === undefined) continue;
		const variants = readVariantsForMemory(database, change.conversationId, { variantIds: change.touchedVariantIds, includeActive: true })
			.filter((variant) => variant.selected && !variant.active && variant.content.trim() !== "");
		const slots = readRecordSlots(drizzle(database), box, instance, variants.map((variant) => variant.variantId));
		for (const variant of variants) {
			const source = sha256(variant.content);
			const key = keyOf(variant.variantId, box);
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
				box, instance, source, epoch: supersede(queue, key), catchUp: null, settled: false,
			});
		}
		queueMicrotask(() => pump(database, queue));
	}
}

/** @approved A Box window's live view of its catch-up run in one Conversation, or null when none runs. */
export function readBoxCatchUp(database: Database, conversationId: number, box: DigestBoxId): BoxCatchUp | null {
	const run = queues.get(database)?.catchUps.get(catchUpKey(conversationId, box));
	return run === undefined ? null : { total: run.total, remaining: run.remaining };
}

// @approved
//  Starts one catch-up run of a Box over the Selected path: every selected
//  Variant without its record for the current text is queued behind live
//  work. A run already in flight is left alone, so a second request is a
//  no-op.
export function startBoxCatchUp(database: Database, conversationId: number, box: DigestBoxId): void {
	const queue = queues.get(database);
	const key = catchUpKey(conversationId, box);
	if (queue === undefined || queue.stopped || queue.catchUps.has(key)) return;
	const instance = digestInstance(database, conversationId, box);
	const path = instance === undefined ? undefined : readSelectedPathForMemory(database, conversationId);
	if (path === undefined || instance === undefined) return;
	const variants = path.flatMap((message) => message.variant === null || message.variant.active || message.variant.content.trim() === "" ? [] : [message.variant]);
	const slots = readRecordSlots(drizzle(database), box, instance, variants.map((variant) => variant.variantId));
	const missing = variants.filter((variant) => {
		const source = sha256(variant.content);
		const jobKey = keyOf(variant.variantId, box);
		const running = queue.running.get(jobKey);
		return !hasAutomaticRecord(slots.get(variant.variantId), variant.content)
			&& !(running !== undefined && running.catchUp === null && running.source === source)
			&& !queue.pending.some((job) => keyOf(job.variantId, job.box) === jobKey && job.source === source)
			&& !queue.catchUpPending.some((job) => keyOf(job.variantId, job.box) === jobKey && job.source === source);
	});
	if (missing.length === 0) return;
	const run: CatchUpRun = { key, total: missing.length, remaining: missing.length };
	queue.catchUps.set(key, run);
	for (const variant of missing) {
		queue.catchUpPending.push({
			conversationId, messageId: variant.messageId, variantId: variant.variantId,
			box, instance, source: sha256(variant.content), epoch: supersede(queue, keyOf(variant.variantId, box)), catchUp: run, settled: false,
		});
	}
	queueMicrotask(() => pump(database, queue));
}

// @approved
//  Cancels one Box's catch-up run: its queued jobs are dropped, its in-flight
//  requests are aborted, and their running entries are released immediately
//  so an aborted Variant can be queued again. No late result lands. Live
//  digest work for the same Variants is untouched.
export function cancelBoxCatchUp(database: Database, conversationId: number, box: DigestBoxId): void {
	const queue = queues.get(database);
	const key = catchUpKey(conversationId, box);
	const run = queue?.catchUps.get(key);
	if (queue === undefined || run === undefined) return;
	queue.catchUps.delete(key);
	queue.catchUpPending = queue.catchUpPending.filter((job) => job.catchUp !== run);
	for (const [jobKey, running] of queue.running) {
		if (running.catchUp !== run) continue;
		queue.running.delete(jobKey);
		running.controller.abort();
	}
}

// @approved
//  Status folds every selected record, as Generation capture does.
const foldDigest = (db: BunSQLiteDatabase, conversationId: number, box: DigestBoxId, setups: BoxSetups, variantIds: readonly number[]) => {
	const slots = readRecordSlots(db, box, readBoxInstances(db, conversationId)[box], variantIds);
	const { records, status } = serverBox(box);
	const setupOf: { readonly [Id in BoxId]?: BoxSetups[keyof BoxSetups] } = setups;
	const setup = setupOf[box];
	return { slots, status: status?.(setup, foldRecords(records, setup, slots, variantIds)) ?? null };
};

/** @approved A minimized digesting Box's dock read: the folded status from the selected Variant ids, loading no prose. */
export function readDigestStatus(database: Database, conversationId: number, box: DigestBoxId) {
	return runConversationReadTransaction(database, (db) => {
		const summary = readConversationSummaryFromConnection(db, conversationId);
		if (summary === undefined) return undefined;
		return { status: foldDigest(db, conversationId, box, summary.boxSetups, readSelectedVariantIdsFromConnection(db, conversationId)).status };
	});
}

/** @approved A digesting Box's window reads one folded Selected path state
 *  without loading discarded Variants or arbitrary Variant data. */
export function readDigest(database: Database, conversationId: number, box: DigestBoxId): DigestRead<BoxDescriptors[DigestBoxId]["record"]> | undefined {
	return runConversationReadTransaction(database, (db) => {
		const summary = readConversationSummaryFromConnection(db, conversationId);
		if (summary === undefined) return undefined;
		const history = readSelectedHistoryFromConnection(db, conversationId, { conversationData: false });
		if (history === undefined) return undefined;
		const variantIds = history.messages.flatMap((message) => message.variant === null ? [] : [message.variant.id]);
		const { slots, status } = foldDigest(db, conversationId, box, summary.boxSetups, variantIds);
		// @approved
		//  An empty Variant, such as an Active Generation's provisional one, has
		//  no settled prose to digest, so it is not listed as a passage.
		const passages = history.messages.flatMap(({ id, author, variant }) => {
			if (variant === null || variant.content.trim() === "") return [];
			const slot = slots.get(variant.id);
			return [{ messageId: id, variantId: variant.id, author: author?.capturedName ?? null, content: variant.content, record: effectiveRecord(slot) ?? null, overridden: slot?.writer !== undefined, digested: hasAutomaticRecord(slot, variant.content) }];
		});
		return {
			conversationId,
			revision: summary.revision,
			status,
			digestReady: resolveBoxDecision(database, box).kind === "ready",
			catchUp: readBoxCatchUp(database, conversationId, box),
			passages,
		};
	});
}
