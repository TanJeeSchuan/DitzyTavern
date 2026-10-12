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
// background by at most two workers; Generations never wait for them. Each
// Variant and Box has at most one current job, and only the current job's
// result lands: a newer job replaces it and aborts it. A catch-up run queues
// one Box's selected Variants without a record behind live work and reports
// its progress to the Box's window.
// Jobs live in memory: work lost on restart is picked up when the passage is
// next selected, resolved or edited, or by another catch-up run.

interface CatchUpRun {
	readonly key: string;
	readonly total: number;
	/** @approved The run's jobs still current and unsettled; leaving twice is harmless. */
	readonly members: Set<DigestJob>;
}

interface DigestJob {
	readonly key: string;
	readonly conversationId: number;
	readonly messageId: number;
	readonly variantId: number;
	readonly box: DigestBoxId;
	/** @approved The Box instance the job writes its record for, read when it was queued. */
	readonly instance: string;
	readonly source: string;
	readonly catchUp: CatchUpRun | null;
	readonly controller: AbortController;
}

interface DigestQueue {
	readonly fetch: ModelFetch | undefined;
	/** @approved The current job of each Variant and Box; a job whose result may land is the one held here. */
	readonly current: Map<string, DigestJob>;
	/** @approved FIFO queues of job references; a reference no longer current is skipped. Live work drains first. */
	readonly live: DigestJob[];
	readonly catchUp: DigestJob[];
	readonly catchUps: Map<string, CatchUpRun>;
	/** @approved Running requests, an aborted one included until it settles. */
	readonly workers: Set<Promise<void>>;
	stopped: boolean;
}

const WORKERS = 2;
const queues = new WeakMap<Database, DigestQueue>();
const keyOf = (variantId: number, box: DigestBoxId) => `${variantId}:${box}`;
const catchUpKey = (conversationId: number, box: BoxId) => `${conversationId}:${box}`;

const leaveCatchUp = (queue: DigestQueue, job: DigestJob): void => {
	const run = job.catchUp;
	if (run === null || !run.members.delete(job) || run.members.size > 0) return;
	if (queue.catchUps.get(run.key) === run) queue.catchUps.delete(run.key);
};

/** @approved Drops the job as current: it is aborted, its result can no longer land, and it leaves its catch-up run. */
const drop = (queue: DigestQueue, job: DigestJob): void => {
	if (queue.current.get(job.key) === job) queue.current.delete(job.key);
	job.controller.abort();
	leaveCatchUp(queue, job);
};

const dropKey = (queue: DigestQueue, key: string): void => {
	const job = queue.current.get(key);
	if (job !== undefined) drop(queue, job);
};

/** @approved Whether live or catch-up work already digests this text. */
const queuedFor = (queue: DigestQueue, key: string, source: string, catchUp: boolean): boolean => {
	const job = queue.current.get(key);
	return job !== undefined && job.source === source && (catchUp || job.catchUp === null);
};

const enqueue = (queue: DigestQueue, job: DigestJob): void => {
	dropKey(queue, job.key);
	queue.current.set(job.key, job);
	job.catchUp?.members.add(job);
	(job.catchUp === null ? queue.live : queue.catchUp).push(job);
};

const runDigest = async (database: Database, queue: DigestQueue, job: DigestJob): Promise<void> => {
	const { signal } = job.controller;
	const { digest } = serverBox(job.box).records;
	try {
		if (!isBoxEnabled(drizzle(database), job.conversationId, job.box)) return;
		const decision = resolveBoxDecision(database, job.box);
		if (decision.kind !== "ready") return;
		const path = readSelectedPathForMemory(database, job.conversationId, { messageId: job.messageId, preceding: digest.window }) ?? [];
		const index = path.findIndex((message) => message.variant?.variantId === job.variantId);
		const variant = path[index]?.variant;
		if (variant === undefined || variant === null || variant.active || sha256(variant.content) !== job.source) return;
		const preceding = path.slice(0, index).flatMap((message) => message.variant === null ? [] : [{ speaker: message.author, content: message.variant.content }]);
		const seed = boxSeed(variantSeedOf(readVariantSeeds(drizzle(database), [job.variantId]).get(job.variantId), job.variantId), job.box);
		const record = await digest.run({ passage: { speaker: variant.speaker, content: variant.content }, preceding, seed }, {
			signal,
			decide: (state, questions) => {
				const { request, fits } = decisionRequest(decision.decision, state, questions);
				if (!fits) throw new Error("The passage exceeds the Decision Model's state token limit.");
				return requestDecisions({ request, questions, selection: decision.decision, fetch: queue.fetch, signal });
			},
		});
		Value.Assert(boxDescriptors[job.box].record, record);
		// @approved
		//  The text may have been edited back to an already-digested version, or
		// the selection cleared, while the request ran; neither replaces the job.
		const current = readVariantsForMemory(database, job.conversationId, { variantIds: [job.variantId], includeActive: true })[0];
		const landing = queue.current.get(job.key) === job && current !== undefined && sha256(current.content) === job.source;
		const enabled = isBoxEnabled(drizzle(database), job.conversationId, job.box);
		if (landing && enabled && resolveBoxDecision(database, job.box).kind === "ready") writeAutomaticRecord(drizzle(database), job.box, job.instance, job.variantId, record, job.source);
	} catch (error) {
		if (!signal.aborted) console.error(`[box-digest] The ${job.box} digest of Variant ${job.variantId} failed.`, error);
	} finally {
		if (queue.current.get(job.key) === job) queue.current.delete(job.key);
		leaveCatchUp(queue, job);
	}
};

const nextJob = (queue: DigestQueue): DigestJob | undefined => {
	for (const pending of [queue.live, queue.catchUp]) {
		for (let job = pending.shift(); job !== undefined; job = pending.shift()) if (queue.current.get(job.key) === job) return job;
	}
	return undefined;
};

const pump = (database: Database, queue: DigestQueue): void => {
	while (!queue.stopped && queue.workers.size < WORKERS) {
		const job = nextJob(queue);
		if (job === undefined) return;
		const worker = runDigest(database, queue, job).finally(() => {
			queue.workers.delete(worker);
			pump(database, queue);
		});
		queue.workers.add(worker);
	}
};

export function startBoxDigests(database: Database, options: { fetch?: ModelFetch | undefined } = {}): () => Promise<void> {
	const queue: DigestQueue = { fetch: options.fetch, current: new Map(), live: [], catchUp: [], catchUps: new Map(), workers: new Set(), stopped: false };
	queues.set(database, queue);
	return async () => {
		queue.stopped = true;
		for (const job of queue.current.values()) job.controller.abort();
		queue.current.clear();
		queue.live.length = 0;
		queue.catchUp.length = 0;
		queue.catchUps.clear();
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
//  A Box that stops running abandons its Chat's work: every current job is
// dropped, so requests in flight abort, no late result lands, and the same
// passages can queue again.
const abandon = (queue: DigestQueue, conversationId: number, box: BoxId): void => {
	for (const job of queue.current.values()) if (job.conversationId === conversationId && job.box === box) drop(queue, job);
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
		for (const variantId of change.removedVariantIds) dropKey(queue, keyOf(variantId, box));
		const instance = change.touchedVariantIds.length === 0 ? undefined : digestInstance(database, change.conversationId, box);
		if (instance === undefined) continue;
		const variants = readVariantsForMemory(database, change.conversationId, { variantIds: change.touchedVariantIds, includeActive: true })
			.filter((variant) => variant.selected && !variant.active && variant.content.trim() !== "");
		const slots = readRecordSlots(drizzle(database), box, instance, variants.map((variant) => variant.variantId));
		for (const variant of variants) {
			const source = sha256(variant.content);
			const key = keyOf(variant.variantId, box);
			// @approved
			//  A live job counts only live work as already queued: a catch-up job
			//  for the same text is replaced, so live work keeps its place ahead
			//  of a catch-up run.
			if (hasAutomaticRecord(slots.get(variant.variantId), variant.content) || queuedFor(queue, key, source, false)) continue;
			enqueue(queue, {
				key, conversationId: change.conversationId, messageId: variant.messageId, variantId: variant.variantId,
				box, instance, source, catchUp: null, controller: new AbortController(),
			});
		}
		queueMicrotask(() => pump(database, queue));
	}
}

/** @approved A Box window's live view of its catch-up run in one Conversation, or null when none runs. */
export function readBoxCatchUp(database: Database, conversationId: number, box: DigestBoxId): BoxCatchUp | null {
	const run = queues.get(database)?.catchUps.get(catchUpKey(conversationId, box));
	return run === undefined ? null : { total: run.total, remaining: run.members.size };
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
	const missing = variants.filter((variant) => !hasAutomaticRecord(slots.get(variant.variantId), variant.content)
		&& !queuedFor(queue, keyOf(variant.variantId, box), sha256(variant.content), true));
	if (missing.length === 0) return;
	const run: CatchUpRun = { key, total: missing.length, members: new Set() };
	queue.catchUps.set(key, run);
	for (const variant of missing) {
		enqueue(queue, {
			key: keyOf(variant.variantId, box), conversationId, messageId: variant.messageId, variantId: variant.variantId,
			box, instance, source: sha256(variant.content), catchUp: run, controller: new AbortController(),
		});
	}
	queueMicrotask(() => pump(database, queue));
}

// @approved
//  Cancels one Box's catch-up run: its jobs are dropped, so queued ones never
//  start, in-flight requests abort, an aborted Variant can be queued again,
//  and no late result lands. Live digest work for the same Variants is
//  untouched.
export function cancelBoxCatchUp(database: Database, conversationId: number, box: DigestBoxId): void {
	const queue = queues.get(database);
	const key = catchUpKey(conversationId, box);
	const run = queue?.catchUps.get(key);
	if (queue === undefined || run === undefined) return;
	queue.catchUps.delete(key);
	for (const job of run.members) drop(queue, job);
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
