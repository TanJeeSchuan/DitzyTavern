import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { boxesWith, boxRecordSchema, boxReference, type BoxId } from "../../shared/contract/box";
import type { BoxCatchUp } from "../../shared/contract/box-digest";
import type { ConversationWriteChange } from "../../shared/contract/conversation-write-change";
import {
	readParticipants, readConversationData, readConversationSummaryFromConnection, readSelectedPassages,
	readSelectedVariantIdsFromConnection, readChatVariants, runConversationReadTransaction,
} from "../conversation";
import { sha256 } from "../hash";
import type { ModelFetch } from "../model-client/types";
import { resolveBoxDecision } from "./decision-settings";
import { effectiveRecord, hasAutomaticRecord, hasDigestError, readBoxFold, readRecordSlots, readVariantSeeds, writeAutomaticRecord, writeDigestError } from "./records";
import { serverBox } from "./registry";
import { boxServices } from "./services";
import { isHostChatKey, readBoxLifecycles } from "./setup";
import { boxSeed, variantSeedOf } from "./seed";
import { readBoxWindow } from "./window";

// @approved
//  The host digest queue (ADR-0050). Selected passages are digested in the
// background by at most two workers; Generations never wait for them. Each
// Variant and Box has at most one current job, and only the current job's
// result lands: a newer job replaces it and aborts it. A catch-up run queues
// one Box's selected Variants without a record behind live work and reports
// its progress to the Box's window. A failed digest writes its error to the
// record slot; live work skips text that already failed, and a catch-up run
// retries it.
// Jobs live in memory: work lost on restart is picked up when the passage is
// next selected, resolved or edited, or by another catch-up run.

interface CatchUpRun {
	readonly key: string;
	readonly total: number;
	/** @approved The run's jobs still current and unsettled; leaving twice is harmless. */
	readonly members: Set<DigestJob>;
	failed: number;
}

interface DigestJob {
	readonly key: string;
	readonly conversationId: number;
	readonly messageId: number;
	readonly variantId: number;
	readonly box: BoxId;
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
const keyOf = (variantId: number, box: BoxId) => `${variantId}:${box}`;
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

/** @approved A digesting Box's server module and digest; the routes refuse any other id before they reach the queue. */
const digesting = (id: BoxId) => {
	const box = serverBox(id);
	const digest = box?.records?.digest;
	if (box === undefined || digest === undefined) throw new Error(`The ${id} Box does not digest.`);
	return { box, digest };
};

const runDigest = async (database: Database, queue: DigestQueue, job: DigestJob): Promise<void> => {
	const { signal } = job.controller;
	const { digest } = digesting(job.box);
	// @approved
	//  A result, or a failure, lands only for the current job while the Box
	// still runs and the Variant still holds the digested text: it may have
	// been edited back to an already-digested version, or the selection
	// cleared, while the request ran; neither replaces the job.
	const lands = (): boolean => {
		const current = readChatVariants(database, job.conversationId, { variantIds: [job.variantId], includeActive: true })[0];
		return queue.current.get(job.key) === job && digestInstance(database, job.conversationId, job.box) === job.instance
			&& current !== undefined && sha256(current.content) === job.source;
	};
	try {
		if (digestInstance(database, job.conversationId, job.box) !== job.instance) return;
		const path = readSelectedPassages(database, job.conversationId, { messageId: job.messageId, preceding: digest.window }) ?? [];
		const index = path.findIndex((message) => message.variant?.variantId === job.variantId);
		const variant = path[index]?.variant;
		if (variant === undefined || variant === null || variant.active || sha256(variant.content) !== job.source) return;
		const preceding = path.slice(0, index).flatMap(({ messageId, author, authorParticipantId, variant }) =>
			variant === null ? [] : [{ messageId, speaker: author, authorId: authorParticipantId, content: variant.content }]);
		const seed = boxSeed(variantSeedOf(readVariantSeeds(drizzle(database), [job.variantId]).get(job.variantId), job.variantId), job.box);
		const services = boxServices(database, queue.fetch, signal)(job.box);
		const data = (readConversationData(database, job.conversationId, { namespace: boxReference(job.box) })?.entries ?? []).filter(({ key }) => !isHostChatKey(key));
		const record = await digest.run({
			passage: { messageId: variant.messageId, speaker: variant.speaker, authorId: variant.authorParticipantId, content: variant.content },
			preceding,
			seed,
			cast: readParticipants(database, job.conversationId),
			data: Object.fromEntries(data.map(({ key, value }) => [key, value])),
		}, { ...services, database });
		if (lands()) writeAutomaticRecord(drizzle(database), job.box, job.instance, job.variantId, record, job.source);
	} catch (error) {
		if (signal.aborted) return;
		console.error(`[box-digest] The ${job.box} digest of Variant ${job.variantId} failed.`, error);
		if (!lands()) return;
		writeDigestError(drizzle(database), job.box, job.instance, job.variantId, job.source, error instanceof Error ? error.message : String(error));
		if (job.catchUp !== null) job.catchUp.failed += 1;
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
const digestInstance = (database: Database, conversationId: number, box: BoxId): string | undefined => {
	const lifecycle = readBoxLifecycles(drizzle(database), conversationId)[box];
	return lifecycle?.state === "enabled" && resolveBoxDecision(database, box).kind === "ready" ? lifecycle.instance : undefined;
};

// @approved
//  A Box that stops running abandons its Chat's work: every current job is
// dropped, so requests in flight abort, no late result lands, and the same
// passages can queue again.
const abandon = (queue: DigestQueue, conversationId: number, box: BoxId): void => {
	for (const job of queue.current.values()) if (job.conversationId === conversationId && job.box === box) drop(queue, job);
	queue.catchUps.delete(catchUpKey(conversationId, box));
};

type Passage = ReturnType<typeof readChatVariants>[number];
const digestible = (variant: Passage): boolean => variant.selected && !variant.active && variant.content.trim() !== "";

// @approved
//  Prepares each passage without a record for its current text as live work;
//  `retry` also queues one whose digest failed on that text.
const prepareLive = (database: Database, queue: DigestQueue, conversationId: number, box: BoxId, instance: string, variants: readonly Passage[], retry: boolean): DigestJob[] => {
	const slots = readRecordSlots(drizzle(database), box, boxRecordSchema(box), instance, variants.map((variant) => variant.variantId));
	const jobs: DigestJob[] = [];
	for (const variant of variants) {
		const source = sha256(variant.content);
		const key = keyOf(variant.variantId, box);
		// @approved
		//  A live job counts only live work as already queued: a catch-up job
		//  for the same text is replaced, so live work keeps its place ahead
		//  of a catch-up run.
		const slot = slots.get(variant.variantId);
		if (hasAutomaticRecord(slot, variant.content) || (!retry && hasDigestError(slot, variant.content)) || queuedFor(queue, key, source, false)) continue;
		jobs.push({
			key, conversationId, messageId: variant.messageId, variantId: variant.variantId,
			box, instance, source, catchUp: null, controller: new AbortController(),
		});
	}
	return jobs;
};

// @approved
//  Prepare queue changes from the write transaction's coherent state.
// Publish only after commit: rejected writes must never abort current work.
export function prepareBoxDigests(database: Database, change: ConversationWriteChange): () => void {
	const queue = queues.get(database);
	if (queue === undefined) return () => {};
	const jobs: DigestJob[] = [];
	const removedKeys: string[] = [];
	const variants = change.touchedVariantIds.length === 0 ? [] : readChatVariants(database, change.conversationId, { variantIds: change.touchedVariantIds, includeActive: true }).filter(digestible);
	for (const [box] of boxesWith("decision")) {
		for (const variantId of change.removedVariantIds) removedKeys.push(keyOf(variantId, box));
		const instance = change.touchedVariantIds.length === 0 ? undefined : digestInstance(database, change.conversationId, box);
		if (instance === undefined) continue;
		jobs.push(...prepareLive(database, queue, change.conversationId, box, instance, variants, false));
	}
	const { conversationId, stoppedBox } = change;
	return () => {
		if (stoppedBox !== undefined) abandon(queue, conversationId, stoppedBox);
		for (const key of removedKeys) dropKey(queue, key);
		for (const job of jobs) enqueue(queue, job);
		queueMicrotask(() => pump(database, queue));
	};
}

/** @approved Queues one selected passage now as live work, retrying a digest that failed on its text; one already digested for its text is left alone. */
export function queueBoxDigest(database: Database, conversationId: number, box: BoxId, { variantId }: { variantId: number }): void {
	const queue = queues.get(database);
	const instance = queue === undefined ? undefined : digestInstance(database, conversationId, box);
	if (queue === undefined || instance === undefined) return;
	for (const job of prepareLive(database, queue, conversationId, box, instance, readChatVariants(database, conversationId, { variantIds: [variantId] }).filter(digestible), true)) enqueue(queue, job);
	queueMicrotask(() => pump(database, queue));
}

/** @approved A Box window's live view of its catch-up run in one Conversation, or null when none runs. */
export function readBoxCatchUp(database: Database, conversationId: number, box: BoxId): BoxCatchUp | null {
	const run = queues.get(database)?.catchUps.get(catchUpKey(conversationId, box));
	return run === undefined ? null : { total: run.total, remaining: run.members.size, failed: run.failed };
}

// @approved
//  Starts one catch-up run of a Box over the Selected path: every selected
//  Variant without its record for the current text, a failed one included,
//  is queued behind live work. A run already in flight is left alone, so a
//  second request is a no-op.
export function startBoxCatchUp(database: Database, conversationId: number, box: BoxId): void {
	const queue = queues.get(database);
	const key = catchUpKey(conversationId, box);
	if (queue === undefined || queue.stopped || queue.catchUps.has(key)) return;
	const instance = digestInstance(database, conversationId, box);
	const path = instance === undefined ? undefined : readSelectedPassages(database, conversationId);
	if (path === undefined || instance === undefined) return;
	const variants = path.flatMap((message) => message.variant === null || message.variant.active || message.variant.content.trim() === "" ? [] : [message.variant]);
	const slots = readRecordSlots(drizzle(database), box, boxRecordSchema(box), instance, variants.map((variant) => variant.variantId));
	const missing = variants.filter((variant) => !hasAutomaticRecord(slots.get(variant.variantId), variant.content)
		&& !queuedFor(queue, keyOf(variant.variantId, box), sha256(variant.content), true));
	if (missing.length === 0) return;
	const run: CatchUpRun = { key, total: missing.length, members: new Set(), failed: 0 };
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
export function cancelBoxCatchUp(database: Database, conversationId: number, box: BoxId): void {
	const queue = queues.get(database);
	const key = catchUpKey(conversationId, box);
	const run = queue?.catchUps.get(key);
	if (queue === undefined || run === undefined) return;
	queue.catchUps.delete(key);
	for (const job of run.members) drop(queue, job);
}

/** @approved A minimized digesting Box's dock read: the folded status from the selected Variant ids, loading no prose. */
export function readDigestStatus(database: Database, conversationId: number, box: BoxId) {
	const { box: host } = digesting(box);
	return runConversationReadTransaction(database, (db) => {
		const summary = readConversationSummaryFromConnection(db, conversationId);
		if (summary === undefined) return undefined;
		const setup = summary.boxSetups[box];
		const { state } = readBoxFold(db, box, host, readBoxLifecycles(db, conversationId)[box]?.instance, setup, readSelectedVariantIdsFromConnection(db, conversationId));
		return { status: host.status?.(setup, state) ?? null };
	});
}

/** @approved A digesting Box's window reads one folded Selected path state
 *  without loading discarded Variants or arbitrary Variant data. */
export function readDigest(database: Database, conversationId: number, box: BoxId) {
	const { box: host } = digesting(box);
	return readBoxWindow(database, conversationId, box, host, ({ summary, history, setup, state, slots }) => {
		// @approved
		//  An empty Variant, such as an Active Generation's provisional one, has
		//  no settled prose to digest, so it is not listed as a passage.
		const passages = history.messages.flatMap(({ id, author, variant }) => {
			if (variant === null || variant.content.trim() === "") return [];
			const slot = slots.get(variant.id);
			return [{
				messageId: id, variantId: variant.id, author: author?.capturedName ?? null, content: variant.content, record: effectiveRecord(slot) ?? null,
				overridden: slot?.writer !== undefined, digested: hasAutomaticRecord(slot, variant.content), error: hasDigestError(slot, variant.content) ? slot?.error?.message ?? null : null,
			}];
		});
		return {
			conversationId,
			revision: summary.revision,
			status: host.status?.(setup, state) ?? null,
			digestReady: resolveBoxDecision(database, box).kind === "ready",
			catchUp: readBoxCatchUp(database, conversationId, box),
			passages,
		};
	});
}
