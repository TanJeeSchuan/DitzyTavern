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

export interface StartGenerationRuntimeInput {
	generationId: number;
	conversationId: number;
	messageId: number;
	variantId: number;
	startedAt: string;
	/** Called for each visible output checkpoint, before subscriber fan-out. */
	onCheckpoint?: (output: { content: string; reasoning: string }) => void;
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

	private readonly runtimes = new Map<number, GenerationRuntime>();

	start(input: StartGenerationRuntimeInput): GenerationRuntime {
		const existing = this.runtimes.get(input.generationId);
		if (existing !== undefined) return existing;
		const runtime = new GenerationRuntime(input);
		this.runtimes.set(input.generationId, runtime);
		return runtime;
	}

	get(generationId: number): GenerationRuntime | undefined {
		return this.runtimes.get(generationId);
	}

	remove(generationId: number): void {
		this.runtimes.delete(generationId);
	}
}

export class GenerationRuntime {
	private readonly subscribers = new Set<Subscriber>();
	private readonly stateSubscribers = new Set<StateSubscriber>();
	private readonly events: GenerationEventEnvelope[] = [];
	private readonly onCheckpoint?: StartGenerationRuntimeInput["onCheckpoint"];
	private stateValue: MutableRuntimeState;
	private readonly controller = new AbortController();

	constructor(input: StartGenerationRuntimeInput) {
		this.onCheckpoint = input.onCheckpoint;
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
		if (event.type === "content" || event.type === "reasoning") {
			this.onCheckpoint?.({
				content: this.stateValue.content,
				reasoning: this.stateValue.reasoning,
			});
		}

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
		return envelope;
	}

	complete(): void {
		if (this.stateValue.status !== "active") return;
		this.stateValue.status = "complete";
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
		this.stateValue.status = "failed";
		this.stateValue.terminalReason = reason;
		this.notifyState();
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
