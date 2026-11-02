import type { Database } from "bun:sqlite";
import { ModelClientGenerationError } from "../model-client";
import { step, type GenerationPhase, type GenerationPhaseEvent, type GenerationRuntimeFailure } from "../../shared/contract/generation-phase";
import type { GenerationStatus } from "../../shared/contract/generation-events";
import type {
	ModelClientEvent,
} from "../model-client";
import { GENERATION_REPLAY_RETENTION_MS } from "../conversation";
import { processStateFor } from "../application/process-state";

/** @approved
 * A normalized event with an application-owned position. Provider streams do
 * not expose a durable ordering contract, so the runtime assigns the order at
 * the one fan-out boundary all clients share.
 */
export interface GenerationEventEnvelope {
	readonly generationId: number;
	readonly eventId: number;
	readonly event: ModelClientEvent;
}

interface GenerationRuntimeProgress {
	readonly generationId: number;
	readonly conversationId: number;
	readonly messageId: number;
	readonly variantId: number;
	readonly startedAt: string;
	readonly content: string;
	readonly reasoning: string;
	readonly latestEventId: number;
}

export type GenerationRuntimeState = GenerationRuntimeProgress & GenerationStatus;

export interface GenerationRuntimeSubscription {
	readonly replayAvailable: boolean;
	readonly state: GenerationRuntimeState;
	close(): void;
}

export interface GenerationCheckpointOptions {
	/**
	 * @approved Checkpoint after this many visible deltas (the normal bounded
	 * cadence). Every checkpoint commits about one database page whatever the
	 * reply's length, so the count prices a reply in commits: 64 keeps a
	 * 4,000-token reply at 62 of them instead of 500, and `intervalMs` bounds
	 * crash loss either way.
	 */
	readonly eventInterval?: number;
	/** @approved Also checkpoint when this amount of time elapsed between visible deltas. */
	readonly intervalMs?: number;
	/** @approved Injectable clock for deterministic lifecycle tests. */
	readonly now?: () => number;
}

/** @approved Each stream's text since the previous successful checkpoint, and the length it starts at. */
export interface CheckpointOutput {
	readonly contentOffset: number;
	readonly contentDelta: string;
	readonly reasoningOffset: number;
	readonly reasoningDelta: string;
	readonly latestEventId: number;
}

// @approved
//  A cadence checkpoint waits while a stream ends between the two halves of a
// surrogate pair: a lone half is stored as U+FFFD, and a checkpoint's text
// must hold everything through the event position it records, because a
// reconnecting client resumes the stream after that position.
const endsInsidePair = (text: string): boolean => {
	const last = text.charCodeAt(text.length - 1);
	return last >= 0xd800 && last <= 0xdbff;
};

export interface StartGenerationRuntimeInput {
	generationId: number;
	conversationId: number;
	messageId: number;
	variantId: number;
	startedAt: string;
	/** @approved Called only at the bounded checkpoint cadence, or by flushCheckpoint. */
	onCheckpoint?: (output: CheckpointOutput) => void;
	/** @approved Aborts the provider attempt owned by the runtime when Stop is requested. */
	onStop?: () => void;
	/** @approved Removes the terminal inspection copy with the retained event buffer. */
	onRetentionExpired?: () => void;
	checkpoint?: GenerationCheckpointOptions;
}

export interface GenerationRuntimeScheduler {
	/** @approved Injectable clock for deterministic lifecycle tests. */
	readonly now?: () => number;
}

type Subscriber = (envelope: GenerationEventEnvelope) => void;
type StateSubscriber = (state: GenerationRuntimeState) => void;

// @approved
//  The runtime's own mutable view of GenerationRuntimeProgress: one field
// derivation from the published state, so a field addition touches one
// declaration and cannot drift between the two.
type MutableRuntimeProgress = {
	-readonly [K in keyof GenerationRuntimeProgress]: GenerationRuntimeProgress[K];
};

/** @approved
 * Process-local fan-out for one database. Event history is deliberately
 * bounded: it is a reconnect aid, not a second copy of Conversation history.
 * One registry instance is owned by the process-state container per database,
 * so in-memory test databases with reused integer IDs never share generations.
 */
export class GenerationRuntimeRegistry {
	static readonly MAX_RETAINED_EVENTS = 256;
	static readonly TERMINAL_REPLAY_RETENTION_MS = GENERATION_REPLAY_RETENTION_MS;

	private readonly runtimes = new Map<number, GenerationRuntime>();
	private readonly now: () => number;
	private readonly pending = new Set<Promise<unknown>>();
	private readonly shutdown = new AbortController();
	private phase: "accepting" | "draining" | "closed" = "accepting";

	constructor(scheduler: GenerationRuntimeScheduler = {}) {
		this.now = scheduler.now ?? Date.now;
	}

	assertAccepting(): void {
		if (this.phase !== "accepting") throw this.shutdownSignal.reason;
	}

	get shutdownSignal(): AbortSignal {
		return this.shutdown.signal;
	}

	beginShutdown(): void {
		if (this.phase !== "accepting") return;
		this.phase = "draining";
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
		const runtime = new GenerationRuntime(input);
		this.runtimes.set(input.generationId, runtime);
		return runtime;
	}

	track<T>(task: Promise<T>): Promise<T> {
		this.pending.add(task);
		void task.then(() => this.pending.delete(task), () => this.pending.delete(task));
		return task;
	}

	/** @approved Join detached work before releasing replay state. The application owns the shutdown deadline. */
	async drain(): Promise<void> {
		if (this.phase === "closed") return;
		this.beginShutdown();
		this.stopAll();
		while (this.pending.size > 0) await Promise.allSettled(this.pending);
		for (const runtime of this.runtimes.values()) { runtime.dispatch({ type: "commit-stop" }); runtime.expireRetention(); }
		this.runtimes.clear();
		this.phase = "closed";
	}

	get(generationId: number): GenerationRuntime | undefined {
		this.cleanup();
		return this.runtimes.get(generationId);
	}

	remove(generationId: number): void {
		this.runtimes.delete(generationId);
	}

	/** @approved Drop terminal runtime state after the bounded reconnect/replay window.
	 * Called lazily on registry access and by the process-state sweep tick
	 * while the process is idle; retention is also enforced independently by
	 * the persisted expiry boundary in Conversation. */
	cleanup(now = this.now()): void {
		for (const [generationId, runtime] of this.runtimes) {
			const terminalAt = runtime.terminalTime;
			if (terminalAt !== null && now - terminalAt >= GenerationRuntimeRegistry.TERMINAL_REPLAY_RETENTION_MS) {
				runtime.expireRetention();
				this.runtimes.delete(generationId);
			}
		}
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
			if (conversationId === undefined || runtime.state.conversationId === conversationId) runtime.dispatch({ type: "request-stop" });
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
	private checkpointedContent = 0;
	private checkpointedReasoning = 0;
	private lastCheckpointAt: number;
	private checkpointPending = false;
	private progress: MutableRuntimeProgress;
	private phase: GenerationPhase = { kind: "active" };
	private readonly controller = new AbortController();

	constructor(input: StartGenerationRuntimeInput) {
		this.onCheckpoint = input.onCheckpoint;
		this.onStop = input.onStop;
		this.onRetentionExpired = input.onRetentionExpired;
		this.checkpointEventInterval = Math.max(1, Math.floor(input.checkpoint?.eventInterval ?? 64));
		this.checkpointIntervalMs = Math.max(0, input.checkpoint?.intervalMs ?? 1_000);
		this.checkpointNow = input.checkpoint?.now ?? Date.now;
		this.lastCheckpointAt = this.checkpointNow();
		this.progress = {
			generationId: input.generationId,
			conversationId: input.conversationId,
			messageId: input.messageId,
			variantId: input.variantId,
			startedAt: input.startedAt,
			content: "",
			reasoning: "",
			latestEventId: 0,
		};
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	get state(): GenerationRuntimeState {
		const outcome = this.phase.kind === "terminal" ? this.phase.outcome : { status: "active" } as const;
		const status: GenerationStatus = outcome.status === "failed"
			? { status: "failed", reason: outcome.failure.reason, imageModel: outcome.failure.imageModel }
			: { status: outcome.status };
		return { ...this.progress, ...status };
	}

	get retainedEvents(): readonly GenerationEventEnvelope[] {
		return this.events;
	}

	publish(event: ModelClientEvent): GenerationEventEnvelope {
		if (this.phase.kind !== "active") {
			// @approved
			//  A late provider frame is ignored rather than being allowed to mutate
			// a terminal generation or appear out of order to a reconnecting client.
			return {
				generationId: this.progress.generationId,
				eventId: this.progress.latestEventId,
				event,
			};
		}

		return this.appendEvent(event);
	}

	private appendEvent(event: ModelClientEvent): GenerationEventEnvelope {
		if (event.type === "content") this.progress.content += event.text;
		if (event.type === "reasoning") this.progress.reasoning += event.text;

		const envelope: GenerationEventEnvelope = {
			generationId: this.progress.generationId,
			eventId: this.progress.latestEventId + 1,
			event,
		};
		this.progress.latestEventId = envelope.eventId;
		this.events.push(envelope);
		while (this.events.length > GenerationRuntimeRegistry.MAX_RETAINED_EVENTS) {
			this.events.shift();
		}
		for (const subscriber of this.subscribers) {
			try { subscriber(envelope); } catch { /* @approved one disconnected observer cannot stop Generation */ }
		}
		this.notifyState();
		if (event.type === "content" || event.type === "reasoning") {
			this.checkpointPending = true;
			const elapsed = this.checkpointNow() - this.lastCheckpointAt;
			if (
				(envelope.eventId - this.lastCheckpointEventId >= this.checkpointEventInterval ||
					(elapsed >= this.checkpointIntervalMs && this.checkpointIntervalMs > 0)) &&
				!endsInsidePair(this.progress.content) && !endsInsidePair(this.progress.reasoning)
			) {
				try { this.flushCheckpoint(); } catch { /* @approved Retry at the next cadence or forced flush. */ }
			}
		}
		return envelope;
	}

	complete(): void {
		this.dispatch({ type: "provider-terminal", outcome: { status: "complete" } });
	}

	fail(failure: GenerationRuntimeFailure): void {
		this.dispatch({ type: "provider-terminal", outcome: { status: "failed", failure } });
	}

	dispatch(event: GenerationPhaseEvent): void {
		if (event.type === "request-stop" && this.phase.kind !== "terminal") this.flushCheckpoint();
		const next = step(this.phase, { ...event, at: this.checkpointNow() });
		if (next === this.phase) return;
		if (next.kind === "terminal") {
			if (next.outcome.status === "failed" && this.events.at(-1)?.event.type !== "failed") {
				const { reason, kind = "transport", responseBody } = next.outcome.failure;
				const failed: Extract<ModelClientEvent, { type: "failed" }> = { type: "failed", kind, message: reason };
				if (responseBody !== undefined) failed.responseBody = responseBody;
				this.appendEvent(failed);
			}
			this.flushCheckpoint();
		}
		this.phase = next;
		if (event.type === "request-stop") {
			try { this.onStop?.(); } catch { /* @approved provider cancellation remains best effort */ }
			if (!this.signal.aborted) this.controller.abort();
		}
		if (next.kind === "terminal") this.notifyState();
	}

	/** @approved Persist the output since the last successful checkpoint immediately, including its event position. */
	flushCheckpoint(): void {
		if (!this.checkpointPending && this.lastCheckpointEventId === this.progress.latestEventId) return;
		const { content, reasoning, latestEventId } = this.progress;
		this.onCheckpoint?.({
			contentOffset: this.checkpointedContent,
			contentDelta: content.slice(this.checkpointedContent),
			reasoningOffset: this.checkpointedReasoning,
			reasoningDelta: reasoning.slice(this.checkpointedReasoning),
			latestEventId,
		});
		this.checkpointedContent = content.length;
		this.checkpointedReasoning = reasoning.length;
		this.checkpointPending = false;
		this.lastCheckpointEventId = this.progress.latestEventId;
		this.lastCheckpointAt = this.checkpointNow();
	}

	get isTerminal(): boolean {
		return this.phase.kind === "terminal";
	}

	get terminalTime(): number | null {
		return this.phase.kind === "terminal" ? this.phase.at : null;
	}

	expireRetention(): void {
		try { this.onRetentionExpired?.(); } catch { /* @approved cleanup is retried by the persisted expiry boundary */ }
	}

	get isStopRequested(): boolean {
		return this.phase.kind === "stopping";
	}

	subscribe(afterEventId: number, onEvent: Subscriber, onState?: StateSubscriber): GenerationRuntimeSubscription {
		const normalizedAfter = Number.isInteger(afterEventId) && afterEventId >= 0
			? afterEventId
			: 0;
		const oldest = this.events[0]?.eventId ?? this.progress.latestEventId + 1;
		const replayAvailable = normalizedAfter >= oldest - 1;
		const effectiveAfter = replayAvailable
			? normalizedAfter
			: this.progress.latestEventId;

		// @approved
		//  When a replay position has fallen out of the bounded buffer, the
		// authoritative state must precede any live frames. The state contains
		// the accumulated text, so retained frames at or before that position
		// are intentionally skipped.
		if (!replayAvailable) {
			try { onState?.(this.state); } catch { /* @approved observer failure cannot stop replay */ }
		}

		// @approved
		//  A subscriber is attached before replay so an event published by an
		// async provider between replay frames cannot be lost or duplicated.
		const subscriber: Subscriber = (envelope) => {
			if (envelope.eventId > effectiveAfter) onEvent(envelope);
		};
		this.subscribers.add(subscriber);
		for (const envelope of this.events) {
			if (envelope.eventId > effectiveAfter) {
				try { onEvent(envelope); } catch { /* @approved observer failure cannot stop replay */ }
			}
		}
		if (this.phase.kind === "terminal" && replayAvailable) {
			try { onState?.(this.state); } catch { /* @approved observer failure cannot stop replay */ }
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
			try { subscriber(current); } catch { /* @approved observer failure cannot stop Generation */ }
		}
	}
}

/** @approved
 * Resolve the process-owned runtime registry for one database scope. HTTP
 * callers and background work share the application database; the registry
 * itself is owned by the process-state container and dies with it.
 */
export function generationRuntimeFor(database: Database): GenerationRuntimeRegistry {
	return processStateFor(database).generationRuntimes;
}
