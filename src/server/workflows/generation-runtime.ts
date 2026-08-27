import type { Database } from "bun:sqlite";
import type {
	ModelClientEvent,
	ModelClientFailureKind,
} from "../model-client";

/**
 * A normalized event with an application-owned position. Provider streams do
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
	readonly status: "active" | "complete" | "failed";
	readonly terminalReason: string | null;
}

export interface GenerationRuntimeSubscription {
	readonly replayAvailable: boolean;
	readonly state: GenerationRuntimeState;
	close(): void;
}

export interface GenerationCheckpointOptions {
	/** Checkpoint after this many visible deltas (the normal bounded cadence). */
	readonly eventInterval?: number;
	/** Also checkpoint when this amount of time elapsed between visible deltas. */
	readonly intervalMs?: number;
	/** Injectable clock for deterministic lifecycle tests. */
	readonly now?: () => number;
}

export interface StartGenerationRuntimeInput {
	generationId: number;
	conversationId: number;
	messageId: number;
	variantId: number;
	startedAt: string;
	/** Called only at the bounded checkpoint cadence, or by flushCheckpoint. */
	onCheckpoint?: (output: { content: string; reasoning: string; latestEventId: number }) => void;
	checkpoint?: GenerationCheckpointOptions;
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
}

/**
 * Process-local fan-out for one database. Event history is deliberately
 * bounded: it is a reconnect aid, not a second copy of Conversation history.
 * The WeakMap registry below prevents in-memory test databases with reused
 * integer IDs from sharing generations.
 */
export class GenerationRuntimeRegistry {
	static readonly MAX_RETAINED_EVENTS = 256;
	static readonly TERMINAL_REPLAY_RETENTION_MS = 5 * 60 * 1_000;

	private readonly runtimes = new Map<number, GenerationRuntime>();

	start(input: StartGenerationRuntimeInput): GenerationRuntime {
		this.cleanup();
		const existing = this.runtimes.get(input.generationId);
		if (existing !== undefined) return existing;
		const runtime = new GenerationRuntime(input);
		this.runtimes.set(input.generationId, runtime);
		return runtime;
	}

	get(generationId: number): GenerationRuntime | undefined {
		this.cleanup();
		return this.runtimes.get(generationId);
	}

	remove(generationId: number): void {
		this.runtimes.delete(generationId);
	}

	/** Drop terminal runtime state after the bounded reconnect/replay window. */
	cleanup(now = Date.now()): void {
		for (const [generationId, runtime] of this.runtimes) {
			const terminalAt = runtime.terminalTime;
			if (terminalAt !== null && now - terminalAt >= GenerationRuntimeRegistry.TERMINAL_REPLAY_RETENTION_MS) {
				this.runtimes.delete(generationId);
			}
		}
	}

	flushAll(): void {
		for (const runtime of this.runtimes.values()) runtime.flushCheckpoint();
	}

	stopAll(): void {
		for (const runtime of this.runtimes.values()) runtime.stop();
	}
}

export class GenerationRuntime {
	private readonly subscribers = new Set<Subscriber>();
	private readonly stateSubscribers = new Set<StateSubscriber>();
	private readonly events: GenerationEventEnvelope[] = [];
	private readonly onCheckpoint?: StartGenerationRuntimeInput["onCheckpoint"];
	private readonly checkpointEventInterval: number;
	private readonly checkpointIntervalMs: number;
	private readonly checkpointNow: () => number;
	private lastCheckpointEventId = 0;
	private lastCheckpointAt: number;
	private checkpointPending = false;
	private stateValue: MutableRuntimeState;
	private readonly controller = new AbortController();
	private terminalAt: number | null = null;

	constructor(input: StartGenerationRuntimeInput) {
		this.onCheckpoint = input.onCheckpoint;
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
		if (this.stateValue.status !== "active") {
			// A late provider frame is ignored rather than being allowed to mutate
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
			try { subscriber(envelope); } catch { /* one disconnected observer cannot stop Generation */ }
		}
		this.notifyState();
		if (event.type === "content" || event.type === "reasoning") {
			this.checkpointPending = true;
			const elapsed = this.checkpointNow() - this.lastCheckpointAt;
			if (
				envelope.eventId - this.lastCheckpointEventId >= this.checkpointEventInterval ||
				(elapsed >= this.checkpointIntervalMs && this.checkpointIntervalMs > 0)
			) {
				this.flushCheckpoint();
			}
		}
		return envelope;
	}

	complete(): void {
		if (this.stateValue.status !== "active") return;
		this.flushCheckpoint();
		this.stateValue.status = "complete";
		this.terminalAt = this.checkpointNow();
		this.notifyState();
	}

	fail(reason: string, kind: ModelClientFailureKind = "transport"): void {
		if (this.stateValue.status !== "active") return;
		// A failure event is part of the same ordered stream. If the provider
		// already emitted one, retain that single authoritative frame rather than
		// duplicating it when the workflow reports its rejected Promise.
		if (this.events.at(-1)?.event.type !== "failed") {
			this.publish({ type: "failed", kind, message: reason });
		}
		this.flushCheckpoint();
		this.stateValue.status = "failed";
		this.stateValue.terminalReason = reason;
		this.terminalAt = this.checkpointNow();
		this.notifyState();
	}

	/** Persist the latest accumulated output immediately, including its event position. */
	flushCheckpoint(): void {
		if (!this.checkpointPending && this.lastCheckpointEventId === this.stateValue.latestEventId) return;
		this.checkpointPending = false;
		this.lastCheckpointEventId = this.stateValue.latestEventId;
		this.lastCheckpointAt = this.checkpointNow();
		try {
			this.onCheckpoint?.({
				content: this.stateValue.content,
				reasoning: this.stateValue.reasoning,
				latestEventId: this.stateValue.latestEventId,
			});
		} catch {
			// A transient checkpoint failure must not stop normalized delivery or
			// turn a provider stream into a client-visible transport failure.
		}
	}

	get isTerminal(): boolean {
		return this.stateValue.status !== "active";
	}

	get terminalTime(): number | null {
		return this.terminalAt;
	}

	stop(): void {
		if (!this.signal.aborted) this.controller.abort();
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

		// When a replay position has fallen out of the bounded buffer, the
		// authoritative state must precede any live frames. The state contains
		// the accumulated text, so retained frames at or before that position
		// are intentionally skipped.
		if (!replayAvailable) {
			try { onState?.(this.state); } catch { /* observer failure cannot stop replay */ }
		}

		// A subscriber is attached before replay so an event published by an
		// async provider between replay frames cannot be lost or duplicated.
		const subscriber: Subscriber = (envelope) => {
			if (envelope.eventId > effectiveAfter) onEvent(envelope);
		};
		this.subscribers.add(subscriber);
		for (const envelope of this.events) {
			if (envelope.eventId > effectiveAfter) {
				try { onEvent(envelope); } catch { /* observer failure cannot stop replay */ }
			}
		}
		if (this.stateValue.status !== "active" && replayAvailable) {
			try { onState?.(this.state); } catch { /* observer failure cannot stop replay */ }
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
			try { subscriber(current); } catch { /* observer failure cannot stop Generation */ }
		}
	}
}

const registries = new WeakMap<Database, GenerationRuntimeRegistry>();
const defaultRegistry = new GenerationRuntimeRegistry();

export function generationRuntimeFor(database: Database): GenerationRuntimeRegistry {
	const existing = registries.get(database);
	if (existing !== undefined) return existing;
	const created = new GenerationRuntimeRegistry();
	registries.set(database, created);
	return created;
}

// The HTTP contract may intentionally open short-lived SQLite connections per
// request. A process-wide registry keeps those request connections attached to
// the same server-owned generation stream in production; injected test
// databases still receive isolated WeakMap registries above.
export function defaultGenerationRuntime(): GenerationRuntimeRegistry {
	return defaultRegistry;
}
