import type { Database } from "bun:sqlite";
import { ModelClientGenerationError } from "../model-client";
import type { GenerationImageModel } from "../../shared/contract/generation-events";
import type {
	ModelClientEvent,
	ModelClientFailureKind,
} from "../model-client";
import { GENERATION_REPLAY_RETENTION_MS } from "../conversation/generation-retention";

/**
 * ==[HUMAN APPROVED]== A normalized event with an application-owned position. Provider streams do
 * not expose a durable ordering contract, so the runtime assigns the order at
 * the one fan-out boundary all clients share.
 */
export interface GenerationEventEnvelope {
	readonly generationId: number;
	readonly eventId: number;
	readonly event: ModelClientEvent;
}

export interface GenerationRuntimeState {
	readonly generationId: number;
	readonly conversationId: number;
	readonly messageId: number;
	readonly variantId: number;
	readonly startedAt: string;
	readonly content: string;
	readonly reasoning: string;
	readonly latestEventId: number;
	readonly status: "active" | "complete" | "stopped" | "failed";
	readonly terminalReason: string | null;
	/** Set on a failure whose request carried Images. */
	readonly imageModel?: GenerationImageModel;
}

export interface GenerationRuntimeSubscription {
	readonly replayAvailable: boolean;
	readonly state: GenerationRuntimeState;
	close(): void;
}

export interface GenerationCheckpointOptions {
	/** ==[HUMAN APPROVED]== Checkpoint after this many visible deltas (the normal bounded cadence). */
	readonly eventInterval?: number;
	/** ==[HUMAN APPROVED]== Also checkpoint when this amount of time elapsed between visible deltas. */
	readonly intervalMs?: number;
	/** ==[HUMAN APPROVED]== Injectable clock for deterministic lifecycle tests. */
	readonly now?: () => number;
}

export interface StartGenerationRuntimeInput {
	generationId: number;
	conversationId: number;
	messageId: number;
	variantId: number;
	startedAt: string;
	/** ==[HUMAN APPROVED]== Called only at the bounded checkpoint cadence, or by flushCheckpoint. */
	onCheckpoint?: (output: { content: string; reasoning: string; latestEventId: number }) => void;
	/** ==[HUMAN APPROVED]== Aborts the provider attempt owned by the runtime when Stop is requested. */
	onStop?: () => void;
	/** ==[HUMAN APPROVED]== Removes the terminal inspection copy with the retained event buffer. */
	onRetentionExpired?: () => void;
	checkpoint?: GenerationCheckpointOptions;
}

export interface GenerationRuntimeScheduleHandle {
	cancel(): void;
}

export interface GenerationRuntimeScheduler {
	readonly now?: () => number;
	readonly schedule?: (callback: () => void, delayMs: number) => GenerationRuntimeScheduleHandle;
	readonly cancel?: (handle: GenerationRuntimeScheduleHandle) => void;
}

type Subscriber = (envelope: GenerationEventEnvelope) => void;
type StateSubscriber = (state: GenerationRuntimeState) => void;

interface MutableRuntimeState {
	generationId: number;
	conversationId: number;
	messageId: number;
	variantId: number;
	startedAt: string;
	content: string;
	reasoning: string;
	latestEventId: number;
	status: GenerationRuntimeState["status"];
	terminalReason: string | null;
	imageModel?: GenerationImageModel;
}

type PendingProviderTerminal =
	| { readonly status: "complete" }
	| { readonly status: "failed"; readonly reason: string; readonly kind: ModelClientFailureKind; readonly responseBody?: string; readonly imageModel?: GenerationImageModel };

/**
 * ==[HUMAN APPROVED]== Process-local fan-out for one database. Event history is deliberately
 * bounded: it is a reconnect aid, not a second copy of Conversation history.
 * The WeakMap registry below prevents in-memory test databases with reused
 * integer IDs from sharing generations.
 */
export class GenerationRuntimeRegistry {
	static readonly MAX_RETAINED_EVENTS = 256;
	static readonly TERMINAL_REPLAY_RETENTION_MS = GENERATION_REPLAY_RETENTION_MS;

	private readonly runtimes = new Map<number, GenerationRuntime>();
	private readonly now: () => number;
	private readonly schedule: (callback: () => void, delayMs: number) => GenerationRuntimeScheduleHandle;
	private readonly cancel: (handle: GenerationRuntimeScheduleHandle) => void;
	private readonly pending = new Set<Promise<unknown>>();
	private readonly shutdown = new AbortController();
	private cleanupHandle: GenerationRuntimeScheduleHandle | undefined;

	constructor(scheduler: GenerationRuntimeScheduler = {}) {
		this.now = scheduler.now ?? Date.now;
		this.schedule = scheduler.schedule ?? ((callback, delayMs) => {
			const handle = setTimeout(callback, delayMs);
			handle.unref?.();
			return { cancel: () => clearTimeout(handle) };
		});
		this.cancel = scheduler.cancel ?? ((handle) => handle.cancel());
	}

	assertAccepting(): void {
		this.shutdownSignal.throwIfAborted();
	}

	get shutdownSignal(): AbortSignal {
		return this.shutdown.signal;
	}

	beginShutdown(): void {
		this.shutdown.abort(new ModelClientGenerationError("cancelled", "Generation runtime is shutting down."));
	}

	start(input: StartGenerationRuntimeInput): GenerationRuntime {
		this.assertAccepting();
		this.cleanup();
		const existing = this.runtimes.get(input.generationId);
		if (existing !== undefined) {
			throw new Error(
				`Generation runtime id ${input.generationId} is already active; duplicate start is an invariant violation.`,
			);
		}
		const runtime = new GenerationRuntime(input, () => this.scheduleCleanup());
		this.runtimes.set(input.generationId, runtime);
		return runtime;
	}

	track<T>(task: Promise<T>): Promise<T> {
		this.pending.add(task);
		void task.then(() => this.pending.delete(task), () => this.pending.delete(task));
		return task;
	}

	/** Join detached work before releasing replay state. The application owns the shutdown deadline. */
	async drain(): Promise<void> {
		this.beginShutdown();
		this.stopAll();
		while (this.pending.size > 0) await Promise.allSettled(this.pending);
		if (this.cleanupHandle !== undefined) this.cancel(this.cleanupHandle);
		this.cleanupHandle = undefined;
		for (const runtime of this.runtimes.values()) { runtime.markStopped(); runtime.expireRetention(); }
		this.runtimes.clear();
	}

	get(generationId: number): GenerationRuntime | undefined {
		this.cleanup();
		return this.runtimes.get(generationId);
	}

	remove(generationId: number): void {
		this.runtimes.delete(generationId);
		this.scheduleCleanup();
	}

	/** ==[HUMAN APPROVED]== Request cancellation for one Generation without touching subscribers. */
	stop(generationId: number, conversationId?: number): GenerationRuntime | undefined {
		const runtime = this.get(generationId);
		if (runtime === undefined || (conversationId !== undefined && runtime.state.conversationId !== conversationId)) {
			return undefined;
		}
		runtime.stop();
		return runtime;
	}

	/** ==[HUMAN APPROVED]== Drop terminal runtime state after the bounded reconnect/replay window. */
	cleanup(now = this.now()): void {
		for (const [generationId, runtime] of this.runtimes) {
			const terminalAt = runtime.terminalTime;
			if (terminalAt !== null && now - terminalAt >= GenerationRuntimeRegistry.TERMINAL_REPLAY_RETENTION_MS) {
				runtime.expireRetention();
				this.runtimes.delete(generationId);
			}
		}
		this.scheduleCleanup();
	}

	private scheduleCleanup(): void {
		if (this.cleanupHandle !== undefined) {
			this.cancel(this.cleanupHandle);
			this.cleanupHandle = undefined;
		}
		if (this.shutdownSignal.aborted) return;
		let nextExpiry: number | undefined;
		for (const runtime of this.runtimes.values()) {
			if (runtime.terminalTime === null) continue;
			const expiry = runtime.terminalTime + GenerationRuntimeRegistry.TERMINAL_REPLAY_RETENTION_MS;
			nextExpiry = nextExpiry === undefined ? expiry : Math.min(nextExpiry, expiry);
		}
		if (nextExpiry === undefined) return;
		this.cleanupHandle = this.schedule(() => {
			this.cleanupHandle = undefined;
			this.cleanup();
		}, Math.max(0, nextExpiry - this.now()));
	}

	flushAll(conversationId?: number): void {
		for (const runtime of this.runtimes.values()) {
			if (conversationId === undefined || runtime.state.conversationId === conversationId) {
				runtime.flushCheckpoint();
			}
		}
	}

	stopAll(conversationId?: number): void {
		for (const runtime of this.runtimes.values()) {
			if (conversationId === undefined || runtime.state.conversationId === conversationId) runtime.stop();
		}
	}
}

export class GenerationRuntime {
	private readonly subscribers = new Set<Subscriber>();
	private readonly stateSubscribers = new Set<StateSubscriber>();
	private readonly events: GenerationEventEnvelope[] = [];
	private readonly onCheckpoint?: StartGenerationRuntimeInput["onCheckpoint"];
	private readonly onStop?: StartGenerationRuntimeInput["onStop"];
	private readonly onRetentionExpired?: StartGenerationRuntimeInput["onRetentionExpired"];
	private readonly checkpointEventInterval: number;
	private readonly checkpointIntervalMs: number;
	private readonly checkpointNow: () => number;
	private lastCheckpointEventId = 0;
	private lastCheckpointAt: number;
	private checkpointPending = false;
	private stateValue: MutableRuntimeState;
	private readonly controller = new AbortController();
	private stopRequested = false;
	private pendingProviderTerminal: PendingProviderTerminal | null = null;
	private terminalAt: number | null = null;

	constructor(input: StartGenerationRuntimeInput, private readonly onTerminal?: () => void) {
		this.onCheckpoint = input.onCheckpoint;
		this.onStop = input.onStop;
		this.onRetentionExpired = input.onRetentionExpired;
		this.checkpointEventInterval = Math.max(1, Math.floor(input.checkpoint?.eventInterval ?? 8));
		this.checkpointIntervalMs = Math.max(0, input.checkpoint?.intervalMs ?? 1_000);
		this.checkpointNow = input.checkpoint?.now ?? Date.now;
		this.lastCheckpointAt = this.checkpointNow();
		this.stateValue = {
			generationId: input.generationId,
			conversationId: input.conversationId,
			messageId: input.messageId,
			variantId: input.variantId,
			startedAt: input.startedAt,
			content: "",
			reasoning: "",
			latestEventId: 0,
			status: "active",
			terminalReason: null,
		};
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	get state(): GenerationRuntimeState {
		return { ...this.stateValue };
	}

	get retainedEvents(): readonly GenerationEventEnvelope[] {
		return this.events;
	}

	publish(event: ModelClientEvent): GenerationEventEnvelope {
		if (this.stateValue.status !== "active" || this.stopRequested) {
			// ==[HUMAN APPROVED]== A late provider frame is ignored rather than being allowed to mutate
			// a terminal generation or appear out of order to a reconnecting client.
			return {
				generationId: this.stateValue.generationId,
				eventId: this.stateValue.latestEventId,
				event,
			};
		}

		if (event.type === "content") this.stateValue.content += event.text;
		if (event.type === "reasoning") this.stateValue.reasoning += event.text;

		const envelope: GenerationEventEnvelope = {
			generationId: this.stateValue.generationId,
			eventId: this.stateValue.latestEventId + 1,
			event,
		};
		this.stateValue.latestEventId = envelope.eventId;
		this.events.push(envelope);
		while (this.events.length > GenerationRuntimeRegistry.MAX_RETAINED_EVENTS) {
			this.events.shift();
		}
		for (const subscriber of this.subscribers) {
			try { subscriber(envelope); } catch { /* one disconnected observer cannot stop Generation ==[HUMAN APPROVED]== */ }
		}
		this.notifyState();
		if (event.type === "content" || event.type === "reasoning") {
			this.checkpointPending = true;
			const elapsed = this.checkpointNow() - this.lastCheckpointAt;
			if (
				envelope.eventId - this.lastCheckpointEventId >= this.checkpointEventInterval ||
				(elapsed >= this.checkpointIntervalMs && this.checkpointIntervalMs > 0)
			) {
				try { this.flushCheckpoint(); } catch { /* ==[HUMAN APPROVED]== Retry at the next cadence or forced flush. */ }
			}
		}
		return envelope;
	}

	complete(): void {
		if (this.stateValue.status !== "active") return;
		if (this.stopRequested) {
			this.pendingProviderTerminal ??= { status: "complete" };
			return;
		}
		this.flushCheckpoint();
		this.stateValue.status = "complete";
		this.terminalAt = this.checkpointNow();
		this.notifyState();
		this.onTerminal?.();
	}

	fail(reason: string, kind: ModelClientFailureKind = "transport", responseBody?: string, imageModel?: GenerationImageModel): void {
		if (this.stateValue.status !== "active") return;
		if (this.stopRequested) {
			this.pendingProviderTerminal ??= { status: "failed", reason, kind, responseBody, imageModel };
			return;
		}
		// ==[HUMAN APPROVED]== A failure event is part of the same ordered stream. If the provider
		// already emitted one, retain that single authoritative frame rather than
		// duplicating it when the workflow reports its rejected Promise.
		if (this.events.at(-1)?.event.type !== "failed") {
			const event: Extract<ModelClientEvent, { type: "failed" }> = { type: "failed", kind, message: reason };
			if (responseBody !== undefined) event.responseBody = responseBody;
			this.publish(event);
		}
		this.flushCheckpoint();
		this.stateValue.status = "failed";
		this.stateValue.terminalReason = reason;
		if (imageModel !== undefined) this.stateValue.imageModel = imageModel;
		this.terminalAt = this.checkpointNow();
		this.notifyState();
		this.onTerminal?.();
	}

	/** ==[HUMAN APPROVED]== Persist the latest accumulated output immediately, including its event position. */
	flushCheckpoint(): void {
		if (!this.checkpointPending && this.lastCheckpointEventId === this.stateValue.latestEventId) return;
		this.onCheckpoint?.({
			content: this.stateValue.content,
			reasoning: this.stateValue.reasoning,
			latestEventId: this.stateValue.latestEventId,
		});
		this.checkpointPending = false;
		this.lastCheckpointEventId = this.stateValue.latestEventId;
		this.lastCheckpointAt = this.checkpointNow();
	}

	get isTerminal(): boolean {
		return this.stateValue.status !== "active";
	}

	get terminalTime(): number | null {
		return this.terminalAt;
	}

	expireRetention(): void {
		try { this.onRetentionExpired?.(); } catch { /* cleanup is retried by the persisted expiry boundary ==[HUMAN APPROVED]== */ }
	}

	stop(): void {
		if (this.stateValue.status !== "active") return;
		// ==[HUMAN APPROVED]== Stop is the explicit server-owned cancellation seam. Flush before
		// aborting so the terminal Conversation transition can use every delta
		// observed by this runtime, even when the provider ignores the abort.
		this.flushCheckpoint();
		this.stopRequested = true;
		try { this.onStop?.(); } catch { /* provider cancellation remains best effort ==[HUMAN APPROVED]== */ }
		if (!this.signal.aborted) this.controller.abort();
	}

	get isStopRequested(): boolean {
		return this.stopRequested;
	}

	/**
	 * ==[HUMAN APPROVED]== Return terminal ownership to the provider after the durable Stop loses
	 * its race. A provider callback observed during cancellation is replayed;
	 * otherwise its eventual callback can settle the still-active runtime.
	 */
	releaseStopRequest(): void {
		if (this.stateValue.status !== "active" || !this.stopRequested) return;
		this.stopRequested = false;
		const pending = this.pendingProviderTerminal;
		this.pendingProviderTerminal = null;
		if (pending?.status === "complete") this.complete();
		if (pending?.status === "failed") this.fail(pending.reason, pending.kind, pending.responseBody, pending.imageModel);
	}

	/** ==[HUMAN APPROVED]== Mark the runtime terminal after the durable Conversation transition. */
	markStopped(): void {
		if (this.stateValue.status !== "active") return;
		this.pendingProviderTerminal = null;
		this.flushCheckpoint();
		this.stateValue.status = "stopped";
		this.terminalAt = this.checkpointNow();
		this.notifyState();
		this.onTerminal?.();
	}

	subscribe(afterEventId: number, onEvent: Subscriber, onState?: StateSubscriber): GenerationRuntimeSubscription {
		const normalizedAfter = Number.isInteger(afterEventId) && afterEventId >= 0
			? afterEventId
			: 0;
		const oldest = this.events[0]?.eventId ?? this.stateValue.latestEventId + 1;
		const replayAvailable = normalizedAfter >= oldest - 1;
		const effectiveAfter = replayAvailable
			? normalizedAfter
			: this.stateValue.latestEventId;

		// ==[HUMAN APPROVED]== When a replay position has fallen out of the bounded buffer, the
		// authoritative state must precede any live frames. The state contains
		// the accumulated text, so retained frames at or before that position
		// are intentionally skipped.
		if (!replayAvailable) {
			try { onState?.(this.state); } catch { /* observer failure cannot stop replay ==[HUMAN APPROVED]== */ }
		}

		// ==[HUMAN APPROVED]== A subscriber is attached before replay so an event published by an
		// async provider between replay frames cannot be lost or duplicated.
		const subscriber: Subscriber = (envelope) => {
			if (envelope.eventId > effectiveAfter) onEvent(envelope);
		};
		this.subscribers.add(subscriber);
		for (const envelope of this.events) {
			if (envelope.eventId > effectiveAfter) {
				try { onEvent(envelope); } catch { /* observer failure cannot stop replay ==[HUMAN APPROVED]== */ }
			}
		}
		if (this.stateValue.status !== "active" && replayAvailable) {
			try { onState?.(this.state); } catch { /* observer failure cannot stop replay ==[HUMAN APPROVED]== */ }
		}

		let closed = false;
		return {
			replayAvailable,
			state: this.state,
			close: () => {
				if (closed) return;
				closed = true;
				this.subscribers.delete(subscriber);
			},
		};
	}

	onStateChange(onState: StateSubscriber): () => void {
		this.stateSubscribers.add(onState);
		return () => this.stateSubscribers.delete(onState);
	}

	private notifyState(): void {
		const current = this.state;
		for (const subscriber of this.stateSubscribers) {
			try { subscriber(current); } catch { /* observer failure cannot stop Generation ==[HUMAN APPROVED]== */ }
		}
	}
}

const registries = new WeakMap<Database, GenerationRuntimeRegistry>();


/**
 * ==[HUMAN APPROVED]== Resolve the process-owned runtime registry for one database scope. HTTP
 * callers and background work share the application database.
 */
export function generationRuntimeFor(database: Database): GenerationRuntimeRegistry {
	const existing = registries.get(database);
	if (existing !== undefined) return existing;
	const created = new GenerationRuntimeRegistry();
	registries.set(database, created);
	return created;
}
