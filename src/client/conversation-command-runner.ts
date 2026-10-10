// @approved
//  One runner for the revisioned Conversation command lifecycle: read the
// authoritative revision, send, and classify the outcome; pending state and
// success work stay with the owning surface.

import { applyConversationCommand, type CommandOutcome, type ConversationAction } from "./conversation";
import type { ConversationSummary } from "../shared/contract/conversation-schema";

// @approved
//  Refused before the send: the client never substitutes a fabricated revision.
export const CONVERSATION_REVISION_UNAVAILABLE_NOTICE =
	"The Conversation revision is not available yet.";

export const CONVERSATION_UNREACHABLE_NOTICE =
	"The Conversation could not be reached.";
export const CONVERSATION_CONFLICT_RELOAD_NOTICE =
	"The Conversation changed elsewhere; the current Cast was loaded.";

// @approved
//  The owning surface: revision null refuses the send, and `isCurrent` is the
//  latest-wins guard evaluated before every effect.
export interface ConversationCommandSurface {
	conversationId: number | null;
	revision: () => number | null;
	onConversationChange: (conversation: ConversationSummary) => void;
	setNotice: (notice: string) => void;
	isCurrent?: () => boolean;
}

// @approved
//  The command family's notice wording: the runner owns when, the surface what.
export interface ConversationCommandNotices {
	conflict: string;
	notFound: string;
	unreachable: string;
}

// @approved
//  `onNotPlayable` and `onNotRemovable` default to the surface notice;
//  `onOperation` receives extra outcomes untouched.
export interface ConversationCommandRunOptions<TOperation = never> {
	notices?: Partial<ConversationCommandNotices>;
	onApplied?: (conversation: ConversationSummary) => void;
	onConflict?: (currentConversation: ConversationSummary) => void;
	onNotPlayable?: (reason: string) => void;
	onNotRemovable?: (reason: string) => void;
	onOperation?: (operation: TOperation) => void;
}

// @approved
//  A surface's own send seam for command families whose results exceed the common set.
export type ConversationCommandSend<TOperation = never> = (
	expectedRevision: number,
) => Promise<CommandOutcome | { outcome: "operation"; operation: TOperation }>;

// What a settled command leaves for the next one queued behind it: the revision it produced when known,
// null when it succeeded without reporting one, false when it failed or was dropped.
type Settled = number | null | false;
const queues = new Map<number, Promise<Settled>>();

/**
 * Runs `command` after every command this client already queued for the Conversation. It receives the revision
 * the last of them produced, and is dropped (settling false) when that one failed, so nothing is sent on top of
 * a change the writer saw but the server refused.
 */
export function queueConversationCommand(conversationId: number, command: (revision: number | null) => Promise<Settled>): Promise<Settled> {
	const settled = (queues.get(conversationId) ?? Promise.resolve(null))
		.then((previous) => previous === false ? false : command(previous))
		.catch(() => false as const);
	queues.set(conversationId, settled);
	void settled.then(() => { if (queues.get(conversationId) === settled) queues.delete(conversationId); });
	return settled;
}

/**
 * Runs one Conversation command against `surface` through the Conversation's command queue: an action goes
 * through the Conversation command route, a function is the surface's own send seam. Resolves whether it applied.
 */
export async function runConversationCommand<TOperation = never>(
	surface: ConversationCommandSurface,
	command: ConversationAction | ConversationCommandSend<TOperation>,
	options: ConversationCommandRunOptions<TOperation> = {},
): Promise<boolean> {
	const run = (previous: number | null) => executeConversationCommand(surface, command, options, previous);
	return await (surface.conversationId === null ? run(null) : queueConversationCommand(surface.conversationId, run)) !== false;
}

async function executeConversationCommand<TOperation>(
	surface: ConversationCommandSurface,
	command: ConversationAction | ConversationCommandSend<TOperation>,
	options: ConversationCommandRunOptions<TOperation>,
	previous: number | null,
): Promise<Settled> {
	const effect = (apply: () => void) => {
		if (surface.isCurrent?.() !== false) apply();
	};
	const known = surface.revision();
	const expectedRevision = known === null ? previous : previous === null ? known : Math.max(known, previous);
	if (expectedRevision === null) {
		effect(() => surface.setNotice(CONVERSATION_REVISION_UNAVAILABLE_NOTICE));
		return false;
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
			return null;
		case "available":
			effect(() => {
				surface.onConversationChange(outcome.value.conversation);
				options.onApplied?.(outcome.value.conversation);
			});
			return outcome.value.conversation.revision;
		case "conflict":
			effect(() => {
				surface.onConversationChange(outcome.currentConversation);
				surface.setNotice(notices.conflict);
				options.onConflict?.(outcome.currentConversation);
			});
			return false;
		case "invalid":
		case "unusable":
			effect(() => surface.setNotice(outcome.reason));
			return false;
		case "not-found":
			effect(() => surface.setNotice(notices.notFound));
			return false;
		case "not-playable":
			effect(() => (options.onNotPlayable ?? surface.setNotice)(outcome.reason));
			return false;
		case "not-removable":
			effect(() => (options.onNotRemovable ?? surface.setNotice)(outcome.reason));
			return false;
		case "network":
			effect(() => surface.setNotice(notices.unreachable));
			return false;
	}
}
