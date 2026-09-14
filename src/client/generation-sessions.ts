// ==[HUMAN APPROVED]== The client Generation session collection: one pure state machine keyed by
// Generation ID that owns subscription phases, event cursors, stop state,
// errors, and terminal handling for every Active Generation the browser
// observes. The machine is deliberately not a durable-state owner: it holds
// no accumulated story model, it addresses story effects by Message and
// Variant id, and every terminal outcome requests an authoritative
// Conversation refresh instead of settling durable state locally.
//
// The reducer is pure and returns ordered effects; the session runner
// (generation-session-runner) executes them against the production SSE
// adapter or a fake one, and the React hook only wires snapshots, commands,
// and story dispatches into it.

import type {
	GenerationAttemptTarget,
	GenerationEvent,
	GenerationStatePayload,
	GenerationStreamStatus,
} from "../shared/contract/generation-events";
import type { GenerationStreamResult } from "./conversation-stream";

// ==[HUMAN APPROVED]== One authoritative snapshot target: the server-owned identity of an Active
// Generation's provisional Variant. It derives from the canonical attempt
// target (ADR-0032) minus the Conversation id, which the collection tracks
// once per view rather than per target.
export type GenerationSessionTarget = Omit<GenerationAttemptTarget, "conversationId"> & {
	readonly initialEventId?: number;
};

// ==[HUMAN APPROVED]== Subscription lifecycle of one observed Generation:
// - `subscribing`: a subscribe effect is outstanding (opening or reconnecting).
// - `observing`: events or an authoritative snapshot have flowed.
// - `detached`: the subscription ended without a terminal outcome; the
//   session keeps its cursor and awaits reconciliation for reattachment.
// - `terminal`: a terminal outcome was observed; the session is inert until
//   a Conversation switch garbage-collects it.
export type GenerationSessionPhase = "subscribing" | "observing" | "detached" | "terminal";

export type GenerationSessionTerminal =
	| { outcome: "applied" }
	| { outcome: "stopped" }
	| { outcome: "not-found" }
	| { outcome: "failed"; reason: string };

export interface GenerationSession {
	readonly conversationId: number;
	readonly generationId: number;
	readonly messageId: number;
	readonly variantId: number;
	readonly phase: GenerationSessionPhase;
	// ==[HUMAN APPROVED]== The latest event position this session processed; reconnection resumes
	// after it instead of replaying unconditionally from event zero.
	readonly lastEventId: number;
	// ==[HUMAN APPROVED]== An explicit Stop command is in flight for this Generation.
	readonly stopPending: boolean;
	// ==[HUMAN APPROVED]== The latest subscription- or stop-level error, cleared by observed
	// liveness or an acknowledged notice.
	readonly error: string | null;
	readonly terminal: GenerationSessionTerminal | null;
	// ==[HUMAN APPROVED]== Consecutive failed subscriptions without observed liveness; bounds the
	// refresh-reattach reconnect loop.
	readonly reconnects: number;
}

export interface GenerationSessionsState {
	// ==[HUMAN APPROVED]== The Conversation whose story the collection currently feeds. Events for
	// sessions of any other Conversation are rejected deterministically.
	readonly activeConversationId: number | null;
	readonly sessions: ReadonlyMap<number, GenerationSession>;
}

// ==[HUMAN APPROVED]== The typed Stop command outcome the session machine understands; the hook
// maps the transport's stop results onto it.
export type GenerationStopCommandOutcome =
	| { outcome: "stopped" }
	| { outcome: "not-found" }
	| { outcome: "failed"; reason: string };

export type GenerationSessionsAction =
	// ==[HUMAN APPROVED]== An authoritative Conversation snapshot was observed; the collection
	// reconciles against its Active Generation targets.
	| { type: "targets-observed"; conversationId: number; targets: readonly GenerationSessionTarget[] }
	// ==[HUMAN APPROVED]== The view is leaving the current Chat: every live local subscription of
	// the active Conversation detaches (cursors persist), terminal sessions
	// are collected, and no server-owned Generation is ever stopped.
	| { type: "conversation-switched" }
	| { type: "event-observed"; generationId: number; eventId: number; event: GenerationEvent }
	| { type: "state-observed"; generationId: number; state: GenerationStatePayload }
	| { type: "subscription-settled"; generationId: number; result: GenerationStreamResult }
	| { type: "stop-started"; generationId: number }
	| { type: "stop-settled"; generationId: number; outcome: GenerationStopCommandOutcome }
	| { type: "stop-all-started" }
	| { type: "stop-all-settled"; outcome: GenerationStopCommandOutcome }
	// ==[HUMAN APPROVED]== The user moved on (new start, new Stop): session errors stop being news.
	| { type: "errors-acknowledged" };

// ==[HUMAN APPROVED]== Story effects stay split by stream kind: Content appends into the story's
// Provisional Variant, an authoritative snapshot replaces it, and Reasoning
// Content travels separately so ordinary history never joins the two.
export type GenerationSessionStoryEffect =
	| { kind: "story-content-delta"; messageId: number; variantId: number; text: string; generationId: number; eventId: number }
	| { kind: "story-state"; messageId: number; variantId: number; content: string; reasoning: string; generationId: number; eventId: number }
	| { kind: "story-reasoning-delta"; messageId: number; variantId: number; text: string; generationId: number; eventId: number };

export type GenerationSessionEffect =
	// ==[HUMAN APPROVED]== Open or reopen this Generation's subscription from the given event
	// position (0 for a fresh session, the session cursor for a reattachment).
	| {
			kind: "subscribe";
			conversationId: number;
			generationId: number;
			messageId: number;
			variantId: number;
			afterEventId: number;
	  }
	// ==[HUMAN APPROVED]== Close this Generation's local subscription. This is teardown only: the
	// machine has no stop effect, so navigation and unsubscription can never
	// cancel a server-owned Active Generation.
	| { kind: "unsubscribe"; generationId: number }
	| GenerationSessionStoryEffect
	// ==[HUMAN APPROVED]== A terminal outcome (or a detached Stop) asks for the authoritative
	// Conversation read; the machine never settles durable state itself.
	| { kind: "refresh-conversation"; conversationId: number };

export interface GenerationSessionsTransition {
	readonly state: GenerationSessionsState;
	readonly effects: readonly GenerationSessionEffect[];
}

// ==[HUMAN APPROVED]== One reconcile/detach step's outcome: the next session map plus the teardown
// effects its changes require.
export interface GenerationSessionMapChange {
	sessions: Map<number, GenerationSession>;
	effects: GenerationSessionEffect[];
}

// ==[HUMAN APPROVED]== How many times a detached session may be reattached without observing any
// liveness before the refresh-reattach loop stands down.
export const MAX_SESSION_RECONNECTS = 5;

export const createGenerationSessions = (): GenerationSessionsState => ({
	activeConversationId: null,
	sessions: new Map(),
});

const unchanged = (state: GenerationSessionsState): GenerationSessionsTransition => ({
	state,
	effects: [],
});

const terminalFromStatus = (
	status: GenerationStreamStatus,
	terminalReason: string | null,
): GenerationSessionTerminal | null => {
	if (status === "active") return null;
	if (status === "complete") return { outcome: "applied" };
	if (status === "stopped") return { outcome: "stopped" };
	return { outcome: "failed", reason: terminalReason ?? "Generation failed." };
};

const livePhases: ReadonlySet<GenerationSessionPhase> = new Set(["subscribing", "observing"]);

// ==[HUMAN APPROVED]== Detach every live session of one Conversation: local subscriptions close
// (unsubscribe effects) while cursors and identity persist for reattachment.
const detachConversationSessions = (
	sessions: ReadonlyMap<number, GenerationSession>,
	conversationId: number,
): GenerationSessionMapChange => {
	const next = new Map(sessions);
	const effects: GenerationSessionEffect[] = [];
	for (const [generationId, session] of next) {
		if (session.conversationId !== conversationId || !livePhases.has(session.phase)) continue;
		next.set(generationId, { ...session, phase: "detached" });
		effects.push({ kind: "unsubscribe", generationId });
	}
	return { sessions: next, effects };
};

const dropTerminalSessions = (
	sessions: ReadonlyMap<number, GenerationSession>,
): Map<number, GenerationSession> => {
	const next = new Map(sessions);
	for (const [generationId, session] of next) {
		if (session.terminal !== null) next.delete(generationId);
	}
	return next;
};

const reconcileTargets = (
	state: GenerationSessionsState,
	action: Extract<GenerationSessionsAction, { type: "targets-observed" }>,
): GenerationSessionsTransition => {
	const effects: GenerationSessionEffect[] = [];
	let sessions: Map<number, GenerationSession> = new Map(state.sessions);

	// ==[HUMAN APPROVED]== Observing a different Conversation is an implicit switch: detach the
	// previous Conversation's live subscriptions and collect terminal rows.
	if (state.activeConversationId !== action.conversationId) {
		if (state.activeConversationId !== null) {
			const detached = detachConversationSessions(sessions, state.activeConversationId);
			sessions = detached.sessions;
			effects.push(...detached.effects);
		}
		sessions = dropTerminalSessions(sessions);
	}

	const knownTargets = new Set<number>();
	let changed = state.activeConversationId !== action.conversationId;
	for (const target of action.targets) {
		knownTargets.add(target.generationId);
		const existing = sessions.get(target.generationId);
		if (existing !== undefined && existing.conversationId === action.conversationId) {
			const initialEventId = target.initialEventId ?? 0;
			if (
				existing.terminal === null &&
				initialEventId > existing.lastEventId
			) {
				changed = true;
				sessions.set(target.generationId, {
					...existing,
					lastEventId: initialEventId,
				});
			}
			// ==[HUMAN APPROVED]== A detached session whose Generation is still server-active
			// reattaches from its own cursor, bounded by the reconnect cap.
			if (existing.phase === "detached" && existing.reconnects < MAX_SESSION_RECONNECTS) {
				changed = true;
				const current = sessions.get(target.generationId) ?? existing;
				sessions.set(target.generationId, { ...current, phase: "subscribing" });
				effects.push({
					kind: "subscribe",
					conversationId: action.conversationId,
					generationId: target.generationId,
					messageId: target.messageId,
					variantId: target.variantId,
					afterEventId: current.lastEventId,
				});
			}
			continue;
		}
		sessions.set(target.generationId, {
			conversationId: action.conversationId,
			generationId: target.generationId,
			messageId: target.messageId,
			variantId: target.variantId,
			phase: "subscribing",
			lastEventId: target.initialEventId ?? 0,
			stopPending: false,
			error: null,
			terminal: null,
			reconnects: 0,
		});
		changed = true;
		effects.push({
			kind: "subscribe",
			conversationId: action.conversationId,
			generationId: target.generationId,
			messageId: target.messageId,
			variantId: target.variantId,
			afterEventId: target.initialEventId ?? 0,
		});
	}
	// ==[HUMAN APPROVED]== A non-terminal session the snapshot no longer lists was settled
	// elsewhere; remove it and close any subscription it still holds.
	for (const [generationId, session] of sessions) {
		if (
			session.conversationId === action.conversationId &&
			session.terminal === null &&
			!knownTargets.has(generationId)
		) {
			changed = true;
			sessions.delete(generationId);
			if (livePhases.has(session.phase)) effects.push({ kind: "unsubscribe", generationId });
		}
	}
	if (!changed) return unchanged(state);
	return { state: { ...state, activeConversationId: action.conversationId, sessions }, effects };
};

const switchConversation = (state: GenerationSessionsState): GenerationSessionsTransition => {
	if (state.activeConversationId === null) return unchanged(state);
	const effects: GenerationSessionEffect[] = [];
	const detached = detachConversationSessions(state.sessions, state.activeConversationId);
	// ==[HUMAN APPROVED]== Leaving a Conversation is a user-paced action: every session left behind
	// gets a fresh reconnect budget for the eventual return.
	let sessions = detached.sessions;
	for (const [generationId, session] of sessions) {
		if (session.conversationId === state.activeConversationId && session.reconnects > 0) {
			sessions.set(generationId, { ...session, reconnects: 0 });
		}
	}
	sessions = dropTerminalSessions(sessions);
	effects.push(...detached.effects);
	return { state: { ...state, activeConversationId: null, sessions }, effects };
};

const activeSession = (
	state: GenerationSessionsState,
	generationId: number,
): GenerationSession | null => {
	const session = state.sessions.get(generationId);
	if (
		session === undefined ||
		state.activeConversationId !== session.conversationId ||
		session.terminal !== null
	) {
		return null;
	}
	return session;
};

// ==[HUMAN APPROVED]== A session that may observe stream traffic: still watching a server-owned
// Active Generation and currently holding a live subscription. Detached
// sessions accept commands (such as Stop) but no observations; reattachment
// is reconcile's job alone.
const observingSession = (
	state: GenerationSessionsState,
	generationId: number,
): GenerationSession | null => {
	const session = activeSession(state, generationId);
	if (session === null || session.phase === "detached") return null;
	return session;
};

const observeEvent = (
	state: GenerationSessionsState,
	action: Extract<GenerationSessionsAction, { type: "event-observed" }>,
): GenerationSessionsTransition => {
	const session = observingSession(state, action.generationId);
	if (session === null || action.eventId <= session.lastEventId) return unchanged(state);
	const next: GenerationSession = {
		...session,
		phase: "observing",
		lastEventId: action.eventId,
		// ==[HUMAN APPROVED]== Observed liveness clears both the stale-error notice and the
		// reconnect counter.
		error: null,
		reconnects: 0,
	};
	const effects: GenerationSessionEffect[] = [];
	if (action.event.type === "content") {
		effects.push({
			kind: "story-content-delta",
			messageId: session.messageId,
			variantId: session.variantId,
			text: action.event.text,
			generationId: session.generationId,
			eventId: action.eventId,
		});
	}
	if (action.event.type === "reasoning") {
		effects.push({
			kind: "story-reasoning-delta",
			messageId: session.messageId,
			variantId: session.variantId,
			text: action.event.text,
			generationId: session.generationId,
			eventId: action.eventId,
		});
	}
	const sessions = new Map(state.sessions);
	sessions.set(action.generationId, next);
	return { state: { ...state, sessions }, effects };
};

const observeState = (
	state: GenerationSessionsState,
	action: Extract<GenerationSessionsAction, { type: "state-observed" }>,
): GenerationSessionsTransition => {
	const session = observingSession(state, action.generationId);
	// ==[HUMAN APPROVED]== The snapshot must describe the session the transport opened it for.
	if (
		session === null ||
		action.state.conversationId !== session.conversationId ||
		action.state.generationId !== session.generationId ||
		action.state.messageId !== session.messageId ||
		action.state.variantId !== session.variantId
	) {
		return unchanged(state);
	}
	const terminal = terminalFromStatus(action.state.status, action.state.terminalReason);
	const effects: GenerationSessionEffect[] = [
		{
			kind: "story-state",
			messageId: session.messageId,
			variantId: session.variantId,
			content: action.state.content,
			generationId: session.generationId,
			eventId: action.state.latestEventId,
			reasoning: action.state.reasoning,
		},
	];
	const next: GenerationSession = {
		...session,
		phase: terminal === null ? "observing" : "terminal",
		lastEventId: Math.max(session.lastEventId, action.state.latestEventId),
		// ==[HUMAN APPROVED]== A terminal snapshot wins any in-flight Stop request and supersedes
		// stale subscription- or stop-level errors from before the terminal
		// outcome was observed.
		stopPending: terminal === null ? session.stopPending : false,
		error: null,
		reconnects: 0,
		terminal,
	};
	const sessions = new Map(state.sessions);
	sessions.set(action.generationId, next);
	if (terminal !== null) effects.push({ kind: "refresh-conversation", conversationId: session.conversationId });
	return { state: { ...state, sessions }, effects };
};

const settleSubscription = (
	state: GenerationSessionsState,
	action: Extract<GenerationSessionsAction, { type: "subscription-settled" }>,
): GenerationSessionsTransition => {
	const session = activeSession(state, action.generationId);
	if (session === null || session.phase === "detached") return unchanged(state);
	const effects: GenerationSessionEffect[] = [];
	let next: GenerationSession;
	if (
		action.result.outcome === "applied" ||
		action.result.outcome === "stopped" ||
		action.result.outcome === "not-found"
	) {
		next = {
			...session,
			phase: "terminal",
			stopPending: false,
			error: null,
			terminal: { outcome: action.result.outcome },
		};
	} else if (action.result.outcome === "interrupted") {
		// ==[HUMAN APPROVED]== The subscription was lost, not the Generation: detach with the error
		// and ask for the authoritative snapshot, whose reconciliation
		// reattaches from the cursor while the Generation is still active.
		next = {
			...session,
			phase: "detached",
			error: action.result.reason,
			reconnects: session.reconnects + 1,
		};
	} else {
		// ==[HUMAN APPROVED]== A server-declared failure is a terminal outcome, not a lost stream:
		// the provider (or the lifecycle) settled this Generation.
		next = {
			...session,
			phase: "terminal",
			stopPending: false,
			error: action.result.reason,
			terminal: { outcome: "failed", reason: action.result.reason },
		};
	}
	effects.push({ kind: "refresh-conversation", conversationId: session.conversationId });
	const sessions = new Map(state.sessions);
	sessions.set(action.generationId, next);
	return { state: { ...state, sessions }, effects };
};

const startStop = (
	state: GenerationSessionsState,
	generationId: number,
): GenerationSessionsTransition => {
	const session = activeSession(state, generationId);
	if (session === null || session.stopPending) return unchanged(state);
	const sessions = new Map(state.sessions);
	sessions.set(generationId, { ...session, stopPending: true });
	return { state: { ...state, sessions }, effects: [] };
};

const startStopAll = (state: GenerationSessionsState): GenerationSessionsTransition => {
	const pending = [...state.sessions.values()].filter(
		(session) =>
			session.conversationId === state.activeConversationId &&
			session.terminal === null &&
			!session.stopPending,
	);
	if (pending.length < 2) return unchanged(state);
	const sessions = new Map(state.sessions);
	for (const session of pending) {
		sessions.set(session.generationId, { ...session, stopPending: true });
	}
	return { state: { ...state, sessions }, effects: [] };
};

const settleStop = (
	state: GenerationSessionsState,
	generationId: number,
	outcome: GenerationStopCommandOutcome,
): GenerationSessionsTransition => {
	const session = state.sessions.get(generationId);
	if (session === undefined || !session.stopPending) return unchanged(state);
	const effects: GenerationSessionEffect[] = [];
	let next: GenerationSession = { ...session, stopPending: false };
	if (outcome.outcome === "failed") {
		next = { ...next, error: outcome.reason };
	} else if (
		next.phase === "detached" &&
		session.conversationId === state.activeConversationId
	) {
		// ==[HUMAN APPROVED]== No live stream will deliver the terminal frame; ask for the
		// authoritative snapshot instead. A live stream settles on its own, and
		// a Conversation the view already left is refreshed when reopened.
		effects.push({ kind: "refresh-conversation", conversationId: session.conversationId });
	}
	const sessions = new Map(state.sessions);
	sessions.set(generationId, next);
	return { state: { ...state, sessions }, effects };
};

const settleStopAll = (
	state: GenerationSessionsState,
	outcome: GenerationStopCommandOutcome,
): GenerationSessionsTransition => {
	const effects: GenerationSessionEffect[] = [];
	const sessions = new Map(state.sessions);
	let detachedStopped = false;
	for (const [generationId, session] of sessions) {
		if (!session.stopPending) continue;
		let next: GenerationSession = { ...session, stopPending: false };
		if (outcome.outcome === "failed" && session.terminal === null) {
			next = { ...next, error: outcome.reason };
		}
		if (
			outcome.outcome !== "failed" &&
			next.phase === "detached" &&
			session.conversationId === state.activeConversationId
		) {
			detachedStopped = true;
		}
		sessions.set(generationId, next);
	}
	if (detachedStopped && state.activeConversationId !== null) {
		effects.push({ kind: "refresh-conversation", conversationId: state.activeConversationId });
	}
	return { state: { ...state, sessions }, effects };
};

const acknowledgeErrors = (state: GenerationSessionsState): GenerationSessionsTransition => {
	const sessions = new Map(state.sessions);
	for (const [generationId, session] of sessions) {
		if (session.error !== null) sessions.set(generationId, { ...session, error: null });
	}
	return { state: { ...state, sessions }, effects: [] };
};

export function reduceGenerationSessions(
	state: GenerationSessionsState,
	action: GenerationSessionsAction,
): GenerationSessionsTransition {
	switch (action.type) {
		case "targets-observed":
			return reconcileTargets(state, action);
		case "conversation-switched":
			return switchConversation(state);
		case "event-observed":
			return observeEvent(state, action);
		case "state-observed":
			return observeState(state, action);
		case "subscription-settled":
			return settleSubscription(state, action);
		case "stop-started":
			return startStop(state, action.generationId);
		case "stop-settled":
			return settleStop(state, action.generationId, action.outcome);
		case "stop-all-started":
			return startStopAll(state);
		case "stop-all-settled":
			return settleStopAll(state, action.outcome);
		case "errors-acknowledged":
			return acknowledgeErrors(state);
	}
}

// ==[HUMAN APPROVED]== True while any session of the active Conversation is still watching a
// server-owned Active Generation (including reconnection gaps).
export const hasActiveGenerationSessions = (state: GenerationSessionsState): boolean => {
	for (const session of state.sessions.values()) {
		if (session.conversationId === state.activeConversationId && session.terminal === null) {
			return true;
		}
	}
	return false;
};

// ==[HUMAN APPROVED]== The first session error of the active Conversation in insertion order, for
// surfaces that show a single Generation notice.
export const firstActiveGenerationSessionError = (
	state: GenerationSessionsState,
): string | null => {
	for (const session of state.sessions.values()) {
		if (
			session.conversationId === state.activeConversationId &&
			session.error !== null
		) {
			return session.error;
		}
	}
	return null;
};

export const hasPendingGenerationStop = (state: GenerationSessionsState): boolean => {
	for (const session of state.sessions.values()) {
		if (
			session.conversationId === state.activeConversationId &&
			session.terminal === null &&
			session.stopPending
		) return true;
	}
	return false;
};
