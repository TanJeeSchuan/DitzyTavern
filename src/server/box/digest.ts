import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { boxRecordSchema, boxReference, type BoxId } from "../../shared/contract/box";
import { automaticStatus, type BoxCatchUp, type DelegateRead } from "../../shared/contract/box-digest";
import type { ConversationWriteChange } from "../../shared/contract/conversation-write-change";
import {
	readParticipants, readConversationData, readConversationSummaryFromConnection, readSelectedPassages,
	readSelectedVariantIdsFromConnection, readChatVariants, runConversationReadTransaction,
} from "../conversation";
import { sha256 } from "../hash";
import type { ModelFetch } from "../model-client/types";
import { resolveBoxDecision } from "./decision-settings";
import { clearAutomaticRecord, effectiveRecord, readBoxFold, readRecordSlots, readVariantSeeds, slotStatus, writeAutomaticRecord, writeDigestError } from "./records";
import { otherBoxTags } from "../../shared/contract/box";
import { delegateRequest } from "../../shared/delegate-request";
import { runDelegateAgent } from "./delegate";
import { readEffectiveBoxDelegateSettings, resolveBoxDelegate } from "./delegate-settings";
import { boxAt, chatBox, chatBoxes, type LoadedBox } from "./registry";
import { boxServices } from "./services";
import { isHostChatKey, readBoxLifecycles, readBoxSetups } from "./setup";
import { boxSeed, variantSeedOf } from "./seed";
import { readBoxWindow, type HostWindowRead } from "./window";
import { announceChange } from "../database/changes";

// @approved
//  The host digest queue (ADR-0050). Selected passages are digested in the
// background by at most two workers; Generations never wait for them. Each
// Variant and Box has at most one current job, and only the current job's
// result lands: a newer job replaces it and aborts it. A catch-up run queues
// one Box's selected Variants without a record behind live work and reports
// its progress to the Box's window. A failed digest writes its error to the
// record slot; live work skips text that already failed, and a catch-up run
// retries it. A delegating Box's tagged passages run its delegate in the
// same queue, under the same landing rules, one at a time per Chat and Box in
// passage order, so each sees the record of every earlier passage that ran.
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
	readonly kind: JobKind;
	readonly key: string;
	readonly conversationId: number;
	readonly messageId: number;
	/** @approved The Message's position, which orders a Chat and Box's delegate jobs. */
	readonly position: number;
	readonly variantId: number;
	readonly box: BoxId;
	/** @approved The Box instance the job writes its record for, and the version it digests with, read when it was queued. */
	readonly instance: string;
	readonly version: string | undefined;
	readonly source: string;
	readonly catchUp: CatchUpRun | null;
	readonly controller: AbortController;
}

interface DigestQueue {
	readonly fetch: ModelFetch | undefined;
	/** @approved How long a delegate's `delegate.apply` may take before its run fails, and an abort that ends that wait when the queue stops. */
	readonly applyMs: number;
	readonly stopping: AbortController;
	/** @approved Tells open windows a catch-up run moved: no row records its start, progress or end. */
	readonly announce: () => void;
	/** @approved The current job of each Variant and Box; a job whose result may land is the one held here. */
	readonly current: Map<string, DigestJob>;
	/** @approved FIFO queues of job references; a reference no longer current is skipped. Live work drains first. */
	readonly live: DigestJob[];
	readonly catchUp: DigestJob[];
	readonly catchUps: Map<string, CatchUpRun>;
	/** @approved Running requests, an aborted one included until it settles. */
	readonly workers: Set<Promise<void>>;
	/** @approved The jobs those workers run, so a Chat and Box's next delegate job waits for the one running. */
	readonly running: Set<DigestJob>;
	stopped: boolean;
}

const WORKERS = 2;
const queues = new WeakMap<Database, DigestQueue>();
const keyOf = (variantId: number, box: BoxId) => `${variantId}:${box}`;
const catchUpKey = (conversationId: number, box: BoxId) => `${conversationId}:${box}`;

const leaveCatchUp = (queue: DigestQueue, job: DigestJob): void => {
	const run = job.catchUp;
	if (run === null || !run.members.delete(job) || queue.catchUps.get(run.key) !== run) return;
	if (run.members.size === 0) queue.catchUps.delete(run.key);
	queue.announce();
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
	if (queue.stopped) return;
	dropKey(queue, job.key);
	queue.current.set(job.key, job);
	job.catchUp?.members.add(job);
	(job.catchUp === null ? queue.live : queue.catchUp).push(job);
};

/** @approved A digest job's record for its passage, or undefined when the passage no longer holds the text it was queued for. */
const digestRecord = async (database: Database, queue: DigestQueue, job: DigestJob, loaded: LoadedBox) => {
	const digest = loaded.box.records?.digest;
	if (digest === undefined) throw new Error(`The ${job.box} Box does not digest.`);
	const path = readSelectedPassages(database, job.conversationId, { messageId: job.messageId, preceding: digest.window }) ?? [];
	const index = path.findIndex((message) => message.variant?.variantId === job.variantId);
	const variant = path[index]?.variant;
	if (variant === undefined || variant === null || variant.active || sha256(variant.content) !== job.source) return undefined;
	const preceding = path.slice(0, index).flatMap(({ messageId, author, authorParticipantId, variant }) =>
		variant === null ? [] : [{ messageId, speaker: author, authorId: authorParticipantId, content: variant.content }]);
	const seed = boxSeed(variantSeedOf(readVariantSeeds(drizzle(database), [job.variantId]).get(job.variantId), job.variantId), job.box);
	const services = boxServices(database, queue.fetch, job.controller.signal)(job.box, resolveBoxDecision(database, job.box));
	const data = (readConversationData(database, job.conversationId, { namespace: boxReference(job.box) })?.entries ?? []).filter(({ key }) => !isHostChatKey(key));
	return await digest.run({
		passage: { messageId: variant.messageId, speaker: variant.speaker, authorId: variant.authorParticipantId, content: variant.content },
		preceding,
		seed,
		cast: readParticipants(database, job.conversationId),
		data: Object.fromEntries(data.map(({ key, value }) => [key, value])),
	}, { ...services, database });
};

// @approved
//  A delegate job's record for its passage: the passage's request, joined
// from its tags, turned by the delegate's agent into one batch of the Box's
// operations, which `delegate.apply` reduces from the state folded from the
// selected records strictly before the passage, never its own earlier
// record or a later one, so a retry cannot apply its request twice. A broken
// delegate setting fails the run with its reason.
const delegateRecord = async (database: Database, queue: DigestQueue, job: DigestJob, loaded: LoadedBox) => {
	const { delegate } = loaded.descriptor;
	const apply = loaded.box.delegate;
	if (delegate === undefined || apply === undefined) throw new Error(`The ${job.box} Box does not delegate.`);
	const path = readSelectedPassages(database, job.conversationId) ?? [];
	const index = path.findIndex((message) => message.variant?.variantId === job.variantId);
	const variant = path[index]?.variant;
	if (variant === undefined || variant === null || variant.active || sha256(variant.content) !== job.source) return undefined;
	const request = delegateRequest(variant.content, delegate.tag, otherBoxTags(delegate.tag));
	if (request === undefined) return undefined;
	const db = drizzle(database);
	const setup = readBoxSetups(db, job.conversationId)[job.box];
	const before = path.slice(0, index).flatMap(({ variant }) => variant === null ? [] : [variant.variantId]);
	const { state } = readBoxFold(db, loaded, job.instance, setup, before);
	const setting = resolveBoxDelegate(database, job.box);
	if (setting.kind !== "ready") throw new Error(setting.kind === "broken" ? setting.reason : "The delegate is off.");
	const { label, summary } = loaded.descriptor;
	const operations = await runDelegateAgent({ options: setting.options, label, summary, operations: delegate.operations, passage: variant.content, request, state, signal: job.controller.signal });
	const cast = readParticipants(database, job.conversationId).flatMap(({ id, name, removed }) => removed ? [] : [{ id, name }]);
	const limits = { aborted: job.controller.signal, stopping: queue.stopping.signal, ms: queue.applyMs };
	return await settledWithin(() => apply.apply({ setup, state, operations, cast }), limits, `The ${job.box} Box's delegate.apply did not settle within ${queue.applyMs / 1000} s.`);
};

// @approved
//  A Box's reducer may never settle, so its run fails once the deadline
// passes. A job aborted before its reducer starts, or a queue already
// stopping, starts none. Once started, the job stays running and holds its
// Chat and Box's lane, aborted or not, so no later passage reads state it
// could still change; a stopping queue stops waiting at once, since no later
// job runs. The reducer starts in the same turn as the checks, so no abort
// lands between them. The wait removes its listener when it ends, either way.
export const settledWithin = <T>(run: () => T | Promise<T>, { aborted, stopping, ms }: { readonly aborted: AbortSignal; readonly stopping: AbortSignal; readonly ms: number }, reason: string): Promise<T> => new Promise((resolve, reject) => {
	if (aborted.aborted) return reject(aborted.reason);
	if (stopping.aborted) return reject(new Error(reason));
	const end = () => {
		clearTimeout(timer);
		stopping.removeEventListener("abort", fail);
	};
	const fail = () => {
		end();
		reject(new Error(reason));
	};
	const timer = setTimeout(fail, ms);
	stopping.addEventListener("abort", fail, { once: true });
	new Promise<T>((settle) => settle(run())).then(resolve, reject).finally(end);
});

/** @approved The default deadline for a delegate's `delegate.apply`, well past what a reducer of one batch takes. */
export const DELEGATE_APPLY_MS = 10_000;

const runJob = async (database: Database, queue: DigestQueue, job: DigestJob): Promise<void> => {
	const { signal } = job.controller;
	const loaded = boxAt(job.box, job.version);
	// @approved
	//  A result, or a failure, lands only for the current job while the Box
	// still runs, at the instance and version the job was queued for, and the
	// Variant still holds the digested text: it may have been edited back to
	// an already-digested version, the selection cleared, or the Chat moved to
	// another version, while the request ran; none replaces the job.
	const runs = (): boolean => {
		const target = jobTarget(database, job.conversationId, job.box);
		return target?.kind === job.kind && target.instance === job.instance && target.loaded.version === job.version;
	};
	const lands = (): boolean => {
		const current = readChatVariants(database, job.conversationId, { variantIds: [job.variantId], includeActive: true })[0];
		return queue.current.get(job.key) === job && runs() && current !== undefined && sha256(current.content) === job.source;
	};
	try {
		if (!runs()) return;
		if (loaded === undefined) throw new Error(`The ${job.box} Box's version ${job.version} is not loaded.`);
		const record = job.kind === "digest" ? await digestRecord(database, queue, job, loaded) : await delegateRecord(database, queue, job, loaded);
		if (record !== undefined && lands()) writeAutomaticRecord(drizzle(database), loaded.descriptor, job.instance, job.variantId, record, job.source);
	} catch (error) {
		if (signal.aborted) return;
		// @approved
		//  A plain Error is a failure the Box chose to report: its message and
		//  any cause are the whole story. Anything else is unexpected and keeps
		//  its stack.
		const reported = error instanceof Error && error.name === "Error";
		console.error(`[box-digest] ${job.box} ${job.kind} failed · Chat ${job.conversationId} · Message ${job.messageId} · Variant ${job.variantId}:`,
			reported ? `${error.message}${error.cause === undefined ? "" : `\n${String(error.cause)}`}` : error);
		if (!lands()) return;
		if (loaded !== undefined) writeDigestError(drizzle(database), loaded.descriptor, job.instance, job.variantId, job.source, error instanceof Error ? error.message : String(error));
		if (job.catchUp !== null) job.catchUp.failed += 1;
	} finally {
		if (queue.current.get(job.key) === job) queue.current.delete(job.key);
		leaveCatchUp(queue, job);
	}
};

// @approved
//  A Chat and Box's delegate jobs run one at a time, in passage order: one
// waits while another of its lane runs, a dropped one included until it
// settles, or while an earlier passage's is current, live or catch-up.
// Digests and other lanes go on around it.
const sameLane = (job: DigestJob) => (other: DigestJob) => other !== job && other.kind === "delegate" && other.conversationId === job.conversationId && other.box === job.box;
const waits = (queue: DigestQueue, job: DigestJob): boolean => job.kind === "delegate"
	&& ([...queue.running].some(sameLane(job)) || [...queue.current.values()].some((other) => sameLane(job)(other) && other.position < job.position));

const nextJob = (queue: DigestQueue): DigestJob | undefined => {
	for (const pending of [queue.live, queue.catchUp]) {
		for (let index = 0; index < pending.length;) {
			const job = pending[index]!; // @approved The loop bound keeps the index inside.
			if (queue.current.get(job.key) !== job) pending.splice(index, 1);
			else if (waits(queue, job)) index += 1;
			else return pending.splice(index, 1)[0];
		}
	}
	return undefined;
};

const pump = (database: Database, queue: DigestQueue): void => {
	while (!queue.stopped && queue.workers.size < WORKERS) {
		const job = nextJob(queue);
		if (job === undefined) return;
		queue.running.add(job);
		const worker = runJob(database, queue, job).finally(() => {
			queue.running.delete(job);
			queue.workers.delete(worker);
			pump(database, queue);
		});
		queue.workers.add(worker);
	}
};

export function startBoxDigests(database: Database, options: { fetch?: ModelFetch | undefined; applyMs?: number } = {}): () => Promise<void> {
	const queue: DigestQueue = { fetch: options.fetch, applyMs: options.applyMs ?? DELEGATE_APPLY_MS, stopping: new AbortController(), announce: () => announceChange(database), current: new Map(), live: [], catchUp: [], catchUps: new Map(), workers: new Set(), running: new Set(), stopped: false };
	queues.set(database, queue);
	return async () => {
		queue.stopped = true;
		queue.stopping.abort();
		for (const job of queue.current.values()) job.controller.abort();
		queue.current.clear();
		queue.live.length = 0;
		queue.catchUp.length = 0;
		queue.catchUps.clear();
		await Promise.all(queue.workers);
		queues.delete(database);
	};
}

type JobKind = "digest" | "delegate";
// @approved
//  What a Box's queued work is in this Chat: the kind of job, the instance it
// writes for and the version the Chat runs it at, or undefined when it may
// not run. The Box must be enabled; a digesting version needs its Decision
// Model selected, and a delegating one a delegate setting, which runs and
// fails with its reason when it does not resolve.
const jobTarget = (database: Database, conversationId: number, box: BoxId): { readonly kind: JobKind; readonly instance: string; readonly loaded: LoadedBox } | undefined => {
	const db = drizzle(database);
	const lifecycle = readBoxLifecycles(db, conversationId)[box];
	const loaded = lifecycle?.state === "enabled" ? chatBox(db, conversationId, box) : undefined;
	if (lifecycle === undefined || loaded === undefined) return undefined;
	if (loaded.descriptor.decision !== undefined) return resolveBoxDecision(database, box).kind === "ready" ? { kind: "digest", instance: lifecycle.instance, loaded } : undefined;
	if (loaded.descriptor.delegate !== undefined) return readEffectiveBoxDelegateSettings(database, box).profileId !== null ? { kind: "delegate", instance: lifecycle.instance, loaded } : undefined;
	return undefined;
};
type JobTarget = NonNullable<ReturnType<typeof jobTarget>>;

/** @approved Whether a passage is work for this kind of job: a digest reads every settled passage, a delegate only one holding its tag. */
const forKind = ({ kind, loaded: { descriptor } }: JobTarget) => (variant: { readonly content: string }): boolean =>
	kind === "digest" || (descriptor.delegate !== undefined && delegateRequest(variant.content, descriptor.delegate.tag, otherBoxTags(descriptor.delegate.tag)) !== undefined);

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
const prepareLive = (database: Database, queue: DigestQueue, conversationId: number, box: BoxId, target: JobTarget, candidates: readonly Passage[], retry: boolean): DigestJob[] => {
	const { kind, instance, loaded } = target;
	const variants = candidates.filter(forKind(target));
	const slots = readRecordSlots(drizzle(database), box, boxRecordSchema(loaded.descriptor), instance, variants.map((variant) => variant.variantId));
	const jobs: DigestJob[] = [];
	for (const variant of variants) {
		const source = sha256(variant.content);
		const key = keyOf(variant.variantId, box);
		// @approved
		//  A live job counts only live work as already queued: a catch-up job
		//  for the same text is replaced, so live work keeps its place ahead
		//  of a catch-up run.
		const status = automaticStatus(slotStatus(slots.get(variant.variantId), variant.content)).kind;
		if (status === "fresh" || (!retry && status === "failed") || queuedFor(queue, key, source, false)) continue;
		jobs.push({
			kind, key, conversationId, messageId: variant.messageId, position: variant.position, variantId: variant.variantId,
			box, instance, version: loaded.version, source, catchUp: null, controller: new AbortController(),
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
	const touched = change.touchedVariantIds.length === 0 ? [] : readChatVariants(database, change.conversationId, { variantIds: change.touchedVariantIds, includeActive: true });
	const variants = touched.filter(digestible);
	// @approved
	//  A job whose passage no longer holds the text it was queued for can never
	// land, so it is dropped as soon as the change commits, even when the new
	// text queues nothing, such as a delegate's tag edited away: it stops its
	// request and no longer holds its Chat and Box's lane.
	const changed: (readonly [string, string])[] = [];
	const db = drizzle(database);
	const lifecycles = readBoxLifecycles(db, change.conversationId);
	for (const [box, { descriptor }] of chatBoxes(db, change.conversationId)) {
		if (descriptor.decision === undefined && descriptor.delegate === undefined) continue;
		for (const variantId of change.removedVariantIds) removedKeys.push(keyOf(variantId, box));
		for (const variant of touched) changed.push([keyOf(variant.variantId, box), sha256(variant.content)]);
		// @approved
		//  A digest's stale record folds until its passage is digested again,
		// but a passage edited to hold no request has no delegate run coming,
		// so its record goes in the same write.
		const { delegate } = descriptor;
		const instance = lifecycles[box]?.instance;
		if (delegate !== undefined && instance !== undefined) {
			for (const variant of touched) if (delegateRequest(variant.content, delegate.tag, otherBoxTags(delegate.tag)) === undefined) clearAutomaticRecord(db, descriptor, instance, variant.variantId);
		}
		const target = change.touchedVariantIds.length === 0 ? undefined : jobTarget(database, change.conversationId, box);
		if (target === undefined) continue;
		jobs.push(...prepareLive(database, queue, change.conversationId, box, target, variants, false));
	}
	const { conversationId, stoppedBox } = change;
	return () => {
		if (stoppedBox !== undefined) abandon(queue, conversationId, stoppedBox);
		for (const key of removedKeys) dropKey(queue, key);
		for (const [key, source] of changed) if (queue.current.get(key)?.source !== source) dropKey(queue, key);
		for (const job of jobs) enqueue(queue, job);
		queueMicrotask(() => pump(database, queue));
	};
}

/** @approved Queues one selected passage now as live work, retrying a digest that failed on its text; one already digested for its text is left alone. */
export function queueBoxDigest(database: Database, conversationId: number, box: BoxId, { variantId }: { variantId: number }): void {
	const queue = queues.get(database);
	const target = queue === undefined ? undefined : jobTarget(database, conversationId, box);
	if (queue === undefined || target === undefined) return;
	for (const job of prepareLive(database, queue, conversationId, box, target, readChatVariants(database, conversationId, { variantIds: [variantId] }).filter(digestible), true)) enqueue(queue, job);
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
	const target = jobTarget(database, conversationId, box);
	const path = target === undefined ? undefined : readSelectedPassages(database, conversationId);
	if (path === undefined || target === undefined) return;
	const { kind, instance, loaded: { descriptor, version } } = target;
	const variants = path.flatMap((message) => message.variant === null || message.variant.active || message.variant.content.trim() === "" ? [] : [message.variant]).filter(forKind(target));
	const slots = readRecordSlots(drizzle(database), box, boxRecordSchema(descriptor), instance, variants.map((variant) => variant.variantId));
	const missing = variants.filter((variant) => automaticStatus(slotStatus(slots.get(variant.variantId), variant.content)).kind !== "fresh"
		&& !queuedFor(queue, keyOf(variant.variantId, box), sha256(variant.content), true));
	if (missing.length === 0) return;
	const run: CatchUpRun = { key, total: missing.length, members: new Set(), failed: 0 };
	queue.catchUps.set(key, run);
	for (const variant of missing) {
		enqueue(queue, {
			kind, key: keyOf(variant.variantId, box), conversationId, messageId: variant.messageId, position: variant.position, variantId: variant.variantId,
			box, instance, version, source: sha256(variant.content), catchUp: run, controller: new AbortController(),
		});
	}
	queue.announce();
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
	queue.announce();
}

/** @approved A minimized digesting Box's dock read: the folded status from the selected Variant ids, loading no prose; a Box that does not digest in this Chat has none. */
export function readDigestStatus(database: Database, conversationId: number, box: BoxId) {
	return runConversationReadTransaction(database, (db) => {
		const loaded = chatBox(db, conversationId, box);
		const summary = loaded?.descriptor.decision === undefined ? undefined : readConversationSummaryFromConnection(db, conversationId);
		if (summary === undefined || loaded === undefined) return undefined;
		const setup = summary.boxSetups[box];
		const { state } = readBoxFold(db, loaded, readBoxLifecycles(db, conversationId)[box]?.instance, setup, readSelectedVariantIdsFromConnection(db, conversationId));
		return { status: loaded.box.status?.(setup, state) ?? null };
	});
}

const EXCERPT_LENGTH = 240;
const excerpt = (content: string) => content.replace(/<[^>]*>|[*_`~#>|]+|^-{3,}$/gm, "").replace(/\s+/g, " ").trim().slice(0, EXCERPT_LENGTH);

/** @approved A digesting Box's window read over one folded Selected path state, without loading discarded Variants or arbitrary Variant data. */
export function digestView(database: Database, { conversationId, summary, history, setup, state, slots }: HostWindowRead, id: BoxId, loaded: LoadedBox) {
	// @approved
	//  An empty Variant, such as an Active Generation's provisional one, has
	//  no settled prose to digest, so it is not listed as a passage.
	const passages = history.messages.flatMap(({ id: messageId, author, variant }) => {
		if (variant === null || variant.content.trim() === "") return [];
		const slot = slots.get(variant.id);
		return [{
			messageId, variantId: variant.id, author: author?.capturedName ?? null, excerpt: excerpt(variant.content), record: effectiveRecord(slot) ?? null,
			status: slotStatus(slot, variant.content),
		}];
	});
	return {
		conversationId,
		revision: summary.revision,
		status: loaded.box.status?.(setup, state) ?? null,
		digestReady: resolveBoxDecision(database, id).kind === "ready",
		catchUp: readBoxCatchUp(database, conversationId, id),
		passages,
	};
}

/** @approved A digesting Box's window read; a Box that does not digest in this Chat has none. */
export const readDigest = (database: Database, conversationId: number, box: BoxId) =>
	readBoxWindow(database, conversationId, box, (window, loaded) => loaded.descriptor.decision === undefined ? undefined : digestView(database, window, box, loaded));

/** @approved A delegating Box's notice read in this Chat; a Box that does not delegate in this Chat has none. */
export const readDelegate = (database: Database, conversationId: number, box: BoxId): DelegateRead | undefined =>
	readBoxWindow(database, conversationId, box, ({ history, slots }, loaded) => {
		if (loaded.descriptor.delegate === undefined) return undefined;
		const setting = resolveBoxDelegate(database, box);
		const statuses = history.messages.flatMap(({ id: messageId, variant }, index) => variant === null ? [] : [{ messageId, variantId: variant.id, number: index + 1, content: variant.content, status: slotStatus(slots.get(variant.id), variant.content) }]);
		const failed = statuses.flatMap(({ status, content: _content, ...passage }) => status.kind === "failed" ? [{ ...passage, error: status.error }] : []);
		const landed = statuses.filter(({ status }) => status.kind === "fresh").length;
		const { tag } = loaded.descriptor.delegate;
		const pending = statuses.filter(({ content, status }) => (status.kind === "missing" || status.kind === "stale") && delegateRequest(content, tag, otherBoxTags(tag)) !== undefined).length;
		return { setting: setting.kind === "ready" ? { kind: "ready" } : setting, landed, pending, catchUp: readBoxCatchUp(database, conversationId, box), failed: failed[0] ?? null };
	});
