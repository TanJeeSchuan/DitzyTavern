import type { Dispatch } from "react";
import {
	applyConversationCommand,
	type ConversationSummary,
} from "../conversation";
import { runConversationCommand } from "../conversation-command-runner";
import {
	classifyVariantSelection,
	displayedVariantId,
	shownVariant,
	type StoryAction,
	type StoryState,
} from "../story";

// @approved
//  The story stage has no command-notice surface: a failed command leaves the
// reading view untouched and the next authoritative read converges it. The
// runner still refuses to send without a revision and normalizes exceptions;
// this surface's adapter simply chooses silence for the standard notices.
const STORY_COMMAND_NOTICES = {
	conflict: "The Conversation changed elsewhere; the current state was loaded.",
	notFound: "The Conversation no longer exists.",
	unreachable: "The Conversation could not be reached.",
};

// @approved
//  The story's no-presentation decision for the precise Conversation-state
// outcomes, made explicit so the runner never flattens them for this surface.
const noPresentation = () => undefined;

type RequestedSelection = { messageId: number; variantId: number };
// Each Chat visit's latest-wins slot, keyed by the visit's signal: whether a select-variant waits in the command
// queue, and the Variant it will send. A later visit never shares a slot with a command an earlier one queued.
const selections = new WeakMap<AbortSignal, { queued: boolean; requested: RequestedSelection | null }>();

type StoryMessageActionsOptions = {
	signal: AbortSignal;
	story: StoryState;
	conversation: ConversationSummary | null;
	dispatchStory: Dispatch<StoryAction>;
	setConversation: (conversation: ConversationSummary | null) => void;
	queueSwipeScroll: (messageId: number) => void;
	canEnterPreview: boolean;
	onEnterPreview: () => void;
};

/**
 * Coordinates user commands that mutate or preview a story Message. Preview state and Requested selections are
 * immediate local presentation; the persisted selection moves only after the server applies the command, and a
 * Requested selection whose command fails is dropped, so a failed Swipe never diverges the two state owners.
 * Selections are latest-wins: at most one select-variant waits in the command queue per Chat, and it sends
 * whichever Variant is requested when its turn comes.
 */
export function useStoryMessageActions({
	signal,
	story,
	conversation,
	dispatchStory,
	setConversation,
	queueSwipeScroll,
	canEnterPreview,
	onEnterPreview,
}: StoryMessageActionsOptions) {
	const surface = {
		conversationId: story.conversationId,
		revision: () => conversation?.revision ?? story.revision,
		onConversationChange: setConversation,
		setNotice: noPresentation,
		isCurrent: () => !signal.aborted,
	};
	const requestSelection = async (conversationId: number, requested: RequestedSelection) => {
		const current = selections.get(signal) ?? { queued: false, requested: null };
		selections.set(signal, current);
		current.requested = requested;
		dispatchStory({ type: "selection-requested", ...requested });
		if (current.queued) return;
		current.queued = true;
		let sent: RequestedSelection | undefined;
		const applied = await runConversationCommand(surface, (expectedRevision) => {
			current.queued = false;
			sent = current.requested ?? requested;
			return applyConversationCommand(conversationId, expectedRevision, { type: "select-variant", ...sent });
		}, {
			notices: STORY_COMMAND_NOTICES,
			onApplied: () => { if (sent !== undefined) dispatchStory({ type: "swipe-selected", ...sent }); },
		});
		current.queued = false;
		if (!applied || current.requested === sent) current.requested = null;
		if (!applied && !signal.aborted) dispatchStory({ type: "selection-dropped", messageId: requested.messageId });
	};

	const changeSwipe = async (messageId: number, direction: -1 | 1) => {
		const storyMessage = story.messages.find((entry) => entry.id === messageId);
		if (storyMessage === undefined) return;
		const preview = story.preview;
		if (preview !== null && preview.messageId !== messageId) return;

		const shownId = displayedVariantId(storyMessage, preview, story.requestedSelections);
		const currentIndex = storyMessage.swipes.findIndex((variant) => variant.id === shownId);
		if (currentIndex === -1) return;
		const targetIndex = Math.min(
			storyMessage.swipes.length - 1,
			Math.max(0, currentIndex + direction),
		);
		const target = storyMessage.swipes[targetIndex];
		if (target === undefined) return;

		if (preview !== null) {
			queueSwipeScroll(messageId);
			dispatchStory({ type: "preview-retargeted", messageId, variantId: target.id });
			return;
		}
		if (!canEnterPreview) return;
		if (conversation === null) return;

		const selection = classifyVariantSelection(story, messageId, target.id);
		if (selection.kind === "noop" || selection.kind === "blocked") return;
		if (selection.kind === "preview") {
			onEnterPreview();
			queueSwipeScroll(messageId);
			dispatchStory({
				type: "preview-started",
				messageId: selection.messageId,
				variantId: selection.variantId,
			});
			return;
		}

		if (story.conversationId === null) return;
		queueSwipeScroll(selection.messageId);
		await requestSelection(story.conversationId, { messageId: selection.messageId, variantId: selection.variantId });
	};

	const editStoryMessage = async (messageId: number, content: string) => {
		if (story.preview !== null) return false;
		const storyMessage = story.messages.find((entry) => entry.id === messageId);
		if (storyMessage === undefined) return false;
		const variantId = shownVariant(story, storyMessage)?.id;
		const conversationId = story.conversationId;
		if (variantId === undefined || conversationId === null) return false;

		let applied = false;
		await runConversationCommand({ ...surface, revision: () => story.revision }, {
			type: "edit-variant",
			messageId,
			variantId,
			content,
		}, {
			notices: STORY_COMMAND_NOTICES,
			onApplied: () => { applied = true; },
		});
		return applied;
	};

	const deleteStoryMessage = async (messageId: number) => {
		if (story.preview !== null) return;
		const conversationId = story.conversationId;
		if (!story.messages.some((entry) => entry.id === messageId) || conversationId === null) return;

		await runConversationCommand(surface, {
			type: "delete-message",
			messageId,
		}, {
			notices: STORY_COMMAND_NOTICES,
		});
	};

	return { changeSwipe, editStoryMessage, deleteStoryMessage };
}
