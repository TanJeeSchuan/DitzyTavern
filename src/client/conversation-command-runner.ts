// @approved
//  One runner for the revisioned Conversation command lifecycle: read the
//  authoritative revision (refusing to send without one), send, normalize a
//  thrown send to the network outcome, then adopt snapshots, show the
//  surface's notice wording, and forward the typed callbacks. Pending state,
//  drafts, and success work stay with the owning surface.

import { applyConversationCommand, type CommandOutcome, type ConversationAction } from "./conversation";
import type { ConversationSummary } from "../shared/contract/conversation-schema";

// @approved
//  Refused before the send: the client never substitutes a fabricated revision.
export const CONVERSATION_REVISION_UNAVAILABLE_NOTICE =
	"The Conversation revision is not available yet.";

// @approved
//  Shared verbatim notices, byte-identical at every adopting site.
export const CONVERSATION_UNREACHABLE_NOTICE =
	"The Conversation could not be reached.";
export const CONVERSATION_CONFLICT_RELOAD_NOTICE =
	"The Conversation changed elsewhere; the current Cast was loaded.";

// @approved
//  The owning surface's state owners: where an action is sent, the revision
//  it is based on (null refuses the send), where an authoritative snapshot
//  and a notice go, and the latest-wins guard evaluated before every effect.
export interface ConversationCommandSurface {
	conversationId: number | null;
	revision: () => number | null;
	onConversationChange: (conversation: ConversationSummary) => void;
	setNotice: (notice: string) => void;
	isCurrent?: () => boolean;
}

// @approved
//  The command family's notice wording: the runner owns when each notice is
//  shown, the surface owns what it says.
export interface ConversationCommandNotices {
	conflict: string;
	notFound: string;
	unreachable: string;
}

// @approved
//  The command family's typed callbacks. `onNotPlayable` and `onNotRemovable`
//  default to the surface notice; `onOperation` receives every extra outcome
//  the send seam wraps, untouched: no adoption, no notice, no classification.
export interface ConversationCommandRunOptions<TOperation = never> {
	notices?: Partial<ConversationCommandNotices>;
	onApplied?: (conversation: ConversationSummary) => void;
	onConflict?: (currentConversation: ConversationSummary) => void;
	onNotPlayable?: (reason: string) => void;
	onNotRemovable?: (reason: string) => void;
	onOperation?: (operation: TOperation) => void;
}

// @approved
//  A surface's own send seam for command families whose results exceed the
//  common Conversation command set; the wrapped extra outcome alone decides
//  its presentation and recovery.
export type ConversationCommandSend<TOperation = never> = (
	expectedRevision: number,
) => Promise<CommandOutcome | { outcome: "operation"; operation: TOperation }>;

/** @approved
 * Runs one Conversation command against `surface`: an action goes through the
 * Conversation command route, a function is the surface's own send seam.
 */
export async function runConversationCommand<TOperation = never>(
	surface: ConversationCommandSurface,
	command: ConversationAction | ConversationCommandSend<TOperation>,
	options: ConversationCommandRunOptions<TOperation> = {},
): Promise<void> {
	const effect = (apply: () => void) => {
		if (surface.isCurrent?.() !== false) apply();
	};
	const expectedRevision = surface.revision();
	if (expectedRevision === null) {
		effect(() => surface.setNotice(CONVERSATION_REVISION_UNAVAILABLE_NOTICE));
		return;
	}
	let outcome: CommandOutcome | { outcome: "operation"; operation: TOperation };
	try {
		outcome = "type" in command
			? await applyConversationCommand(surface.conversationId!, expectedRevision, command)
			: await command(expectedRevision);
	} catch {
		outcome = { outcome: "network" };
	}
	const notices = {
		conflict: CONVERSATION_CONFLICT_RELOAD_NOTICE,
		notFound: CONVERSATION_UNREACHABLE_NOTICE,
		unreachable: CONVERSATION_UNREACHABLE_NOTICE,
		...options.notices,
	};
	switch (outcome.outcome) {
		case "operation":
			effect(() => options.onOperation?.(outcome.operation));
			return;
		case "available":
			effect(() => {
				surface.onConversationChange(outcome.value.conversation);
				options.onApplied?.(outcome.value.conversation);
			});
			return;
		case "conflict":
			effect(() => {
				surface.onConversationChange(outcome.currentConversation);
				surface.setNotice(notices.conflict);
				options.onConflict?.(outcome.currentConversation);
			});
			return;
		case "invalid":
		case "unusable":
			effect(() => surface.setNotice(outcome.reason));
			return;
		case "not-found":
			effect(() => surface.setNotice(notices.notFound));
			return;
		case "not-playable":
			effect(() => (options.onNotPlayable ?? surface.setNotice)(outcome.reason));
			return;
		case "not-removable":
			effect(() => (options.onNotRemovable ?? surface.setNotice)(outcome.reason));
			return;
		case "network":
			effect(() => surface.setNotice(notices.unreachable));
			return;
	}
}
