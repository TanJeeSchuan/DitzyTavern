// @approved
// One runner for the common revisioned Conversation command lifecycle. Every
//  Conversation command follows the same shape: read the authoritative
// revision, send the command, classify its typed outcome, and reconcile —
// adopt the authoritative snapshot after an applied or conflicting command,
// show the standard notice for each failure class, and never send a command
// without a real revision. Repeating that epilogue at every caller let
// conflict wording, exception handling, and revision fallbacks drift, so the
// common part lives here while each surface keeps its own pending state,
// draft preservation, and operation-specific success work.

import type { ConversationSummary } from "../shared/contract/conversation-schema";
import type { CommandOutcome } from "./conversation";

// @approved
// Notice shown when no authoritative Conversation revision is available. The
//  command is refused before it is sent: the client never substitutes a
// fabricated revision.
export const CONVERSATION_REVISION_UNAVAILABLE_NOTICE =
	"The Conversation revision is not available yet.";

// @approved
// Reads the authoritative Conversation revision a command is based on, in the
//  form the owning surface stores it (the loaded snapshot or the story read
// model). Returning null means that revision is not available yet; the runner
// then refuses to send instead of falling back to a fabricated value.
export type ConversationRevisionSource = () => number | null;

// @approved
// Reconciliation side effects shared by every Conversation command path,
//  injected by the owning surface so the runner and its tests need no React
// or global state. Production wiring maps these onto each surface's own
// state owners (the Conversation snapshot setter and its notice state).
export interface ConversationCommandReconciliation {
	// @approved
	// Adopt an authoritative snapshot: the applied Conversation after a
	//  command succeeds, or the current Conversation a conflict carries (the
	// canonical conflict reload, so a stale surface converges immediately).
	adoptSnapshot: (conversation: ConversationSummary) => void;
	// @approved
	// Show a command-failure notice through the surface's own notice state.
	showNotice: (notice: string) => void;
}

// @approved
// Caller-owned wording for the standard notices. The runner owns when each
//  notice is shown; the surface owns what it says, because each surface names
// what it preserved or could not reach.
export interface ConversationCommandNotices {
	// @approved
	// Shown when the command conflicts with a newer Conversation revision.
	conflict: string;
	// @approved
	// Shown when the Conversation no longer exists.
	notFound: string;
	// @approved
	// Shown when the command could not be delivered; exception normalization
	//  maps a thrown send onto this notice too.
	unreachable: string;
}

// @approved
// Typed callbacks the runner never interprets. `onApplied` and `onConflict`
//  carry synchronous operation-specific state changes and confirmations.
// Authoritative reloads belong to the state owner that observes the adopted snapshot.
// `onNotPlayable` and `onNotRemovable` are required: those
// Conversation-state outcomes keep their precise meaning, so every adopting
// surface must decide their presentation instead of falling into a generic
// failure branch. `onOperation` receives every `ConversationOperationOutcome`
// the send seam returns, untouched: command families whose outcomes exceed
// the common Conversation command set keep their extra outcomes through it.
export interface ConversationCommandCallbacks<TOperation = never> {
	onApplied?: (conversation: ConversationSummary) => void;
	onConflict?: (currentConversation: ConversationSummary) => void;
	onNotPlayable: (reason: string) => void;
	onNotRemovable: (reason: string) => void;
	onOperation?: (operation: TOperation) => void;
}

// @approved
// An outcome the runner never interprets: no adoption, no notice, no
//  classification. Command families whose send results exceed the common
// Conversation command set — for example a character-library conflict that
// names the changed Character instead of carrying a Conversation snapshot,
// or a success that carries a Character while the Conversation stays
// untouched — wrap those extra outcomes in this shape at the send seam. The
// runner forwards the wrapped value to the `onOperation` typed callback,
// which alone decides its presentation and recovery.
export interface ConversationOperationOutcome<TOperation> {
	outcome: "operation";
	operation: TOperation;
}

// @approved
// One revisioned Conversation command execution: the revision source the
//  runner consults at send time, the command itself, the injected
// reconciliation adapter, the surface-owned notice wording, and the typed
// operation-specific callbacks. The send seam returns the common Conversation
// outcomes plus, when the command family carries them, operation outcomes
// wrapped in `ConversationOperationOutcome`.
export interface ConversationCommandOptions<TOperation = never> {
	revision: ConversationRevisionSource;
	send: (
		expectedRevision: number,
	) => Promise<CommandOutcome | ConversationOperationOutcome<TOperation>>;
	reconciliation: ConversationCommandReconciliation;
	notices: ConversationCommandNotices;
	callbacks: ConversationCommandCallbacks<TOperation>;
}

/** @approved
 * Runs one Conversation command through the common lifecycle. Obtains the
 * authoritative revision and refuses to send without one, normalizes send
 * exceptions to the network outcome, then handles the common typed outcomes
 * exhaustively: applied snapshot adoption plus `onApplied`, canonical
 * conflict reload plus `onConflict`, the invalid/not-found/network notices,
 * the typed operation-specific callbacks for `not-playable` and
 * `not-removable`, and untouched forwarding of operation outcomes to
 * `onOperation`. Pending state, drafts, and success work stay with the
 * caller.
 */
export async function runConversationCommand<TOperation = never>(
	options: ConversationCommandOptions<TOperation>,
): Promise<void> {
	const expectedRevision = options.revision();
	if (expectedRevision === null) {
		options.reconciliation.showNotice(CONVERSATION_REVISION_UNAVAILABLE_NOTICE);
		return;
	}
	let outcome: CommandOutcome | ConversationOperationOutcome<TOperation>;
	try {
		outcome = await options.send(expectedRevision);
	} catch {
		outcome = { outcome: "network" };
	}
	switch (outcome.outcome) {
		case "operation":
			options.callbacks.onOperation?.(outcome.operation);
			return;
		case "available":
			options.reconciliation.adoptSnapshot(outcome.value.conversation);
			options.callbacks.onApplied?.(outcome.value.conversation);
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

// @approved
//  Shared verbatim notices: byte-identical at every adopting site, so the
// wording can never drift between surfaces.
export const CONVERSATION_UNREACHABLE_NOTICE =
	"The Conversation could not be reached.";
export const CONVERSATION_CONFLICT_RELOAD_NOTICE =
	"The Conversation changed elsewhere; the current Cast was loaded.";
