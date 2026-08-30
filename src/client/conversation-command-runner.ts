// One runner for the common revisioned Conversation command lifecycle. Every
// Conversation command follows the same shape: read the authoritative
// revision, send the command, classify its typed outcome, and reconcile —
// adopt the authoritative snapshot after an applied or conflicting command,
// show the standard notice for each failure class, and never send a command
// without a real revision. Repeating that epilogue at every caller let
// conflict wording, exception handling, and revision fallbacks drift, so the
// common part lives here while each surface keeps its own pending state,
// draft preservation, and operation-specific success work.

import type { ConversationSummary } from "../shared/contract/conversation-schema";
import type { CommandOutcome } from "./conversation";

// Notice shown when no authoritative Conversation revision is available. The
// command is refused before it is sent: the client never substitutes a
// fabricated revision.
export const CONVERSATION_REVISION_UNAVAILABLE_NOTICE =
	"The Conversation revision is not available yet.";

// Reads the authoritative Conversation revision a command is based on, in the
// form the owning surface stores it (the loaded snapshot or the story read
// model). Returning null means that revision is not available yet; the runner
// then refuses to send instead of falling back to a fabricated value.
export type ConversationRevisionSource = () => number | null;

// Reconciliation side effects shared by every Conversation command path,
// injected by the owning surface so the runner and its tests need no React
// or global state. Production wiring maps these onto each surface's own
// state owners (the Conversation snapshot setter and its notice state).
export interface ConversationCommandReconciliation {
	// Adopt an authoritative snapshot: the applied Conversation after a
	// command succeeds, or the current Conversation a conflict carries (the
	// canonical conflict reload, so a stale surface converges immediately).
	adoptSnapshot: (conversation: ConversationSummary) => void;
	// Show a command-failure notice through the surface's own notice state.
	showNotice: (notice: string) => void;
}

// Caller-owned wording for the standard notices. The runner owns when each
// notice is shown; the surface owns what it says, because each surface names
// what it preserved or could not reach.
export interface ConversationCommandNotices {
	// Shown when the command conflicts with a newer Conversation revision.
	conflict: string;
	// Shown when the Conversation no longer exists.
	notFound: string;
	// Shown when the command could not be delivered; exception normalization
	// maps a thrown send onto this notice too.
	unreachable: string;
}

// Typed callbacks the runner never interprets. `onApplied` and `onConflict`
// carry operation-specific success and reload work (local state sync,
// confirmations, reloading authoritative operation data while drafts stay
// untouched). `onNotPlayable` and `onNotRemovable` are required: those
// Conversation-state outcomes keep their precise meaning, so every adopting
// surface must decide their presentation instead of falling into a generic
// failure branch.
export interface ConversationCommandCallbacks {
	onApplied?: (conversation: ConversationSummary) => void;
	onConflict?: (currentConversation: ConversationSummary) => void;
	onNotPlayable: (reason: string) => void;
	onNotRemovable: (reason: string) => void;
}

// One revisioned Conversation command execution: the revision source the
// runner consults at send time, the command itself, the injected
// reconciliation adapter, the surface-owned notice wording, and the typed
// operation-specific callbacks.
export interface ConversationCommandOptions {
	revision: ConversationRevisionSource;
	send: (expectedRevision: number) => Promise<CommandOutcome>;
	reconciliation: ConversationCommandReconciliation;
	notices: ConversationCommandNotices;
	callbacks: ConversationCommandCallbacks;
}

/**
 * Runs one Conversation command through the common lifecycle. Obtains the
 * authoritative revision and refuses to send without one, normalizes send
 * exceptions to the network outcome, then handles the common typed outcomes
 * exhaustively: applied snapshot adoption plus `onApplied`, canonical
 * conflict reload plus `onConflict`, the invalid/not-found/network notices,
 * and the typed operation-specific callbacks for `not-playable` and
 * `not-removable`. Pending state, drafts, and success work stay with the
 * caller.
 */
export async function runConversationCommand(options: ConversationCommandOptions): Promise<void> {
	const expectedRevision = options.revision();
	if (expectedRevision === null) {
		options.reconciliation.showNotice(CONVERSATION_REVISION_UNAVAILABLE_NOTICE);
		return;
	}
	let outcome: CommandOutcome;
	try {
		outcome = await options.send(expectedRevision);
	} catch {
		outcome = { status: "network" };
	}
	switch (outcome.status) {
		case "applied":
			options.reconciliation.adoptSnapshot(outcome.conversation);
			options.callbacks.onApplied?.(outcome.conversation);
			return;
		case "conflict":
			options.reconciliation.adoptSnapshot(outcome.currentConversation);
			options.reconciliation.showNotice(options.notices.conflict);
			options.callbacks.onConflict?.(outcome.currentConversation);
			return;
		case "invalid":
			options.reconciliation.showNotice(outcome.reason);
			return;
		case "not-found":
			options.reconciliation.showNotice(options.notices.notFound);
			return;
		case "not-playable":
			options.callbacks.onNotPlayable(outcome.reason);
			return;
		case "not-removable":
			options.callbacks.onNotRemovable(outcome.reason);
			return;
		case "network":
			options.reconciliation.showNotice(options.notices.unreachable);
			return;
	}
}
