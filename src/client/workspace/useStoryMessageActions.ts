import type { BoxMoves } from "../../shared/contract/box-generation";
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
	previewOnMessage,
	type RequestedWrite,
	type StoryAction,
	type StoryState,
	isStoryReady,
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

type RequestedSelection = { messageId: number; request: RequestedWrite<number> };
const selections = new WeakMap<AbortSignal, { queued: boolean; requested: RequestedSelection | null }>();

type StoryMessageActionsOptions = {
	signal: AbortSignal;
	story: StoryState;
	commandRevision: () => number | null;
	dispatchStory: Dispatch<StoryAction>;
	setConversation: (conversation: ConversationSummary | null) => void;
	queueSwipeScroll: (messageId: number) => void;
	canEnterPreview: boolean;
	onEnterPreview: (enter: () => void) => void;
};

export function useStoryMessageActions({
	signal,
	story,
	commandRevision,
	dispatchStory,
	setConversation,
	queueSwipeScroll,
	canEnterPreview,
	onEnterPreview,
}: StoryMessageActionsOptions) {
	const surface = {
		revision: commandRevision,
		onConversationChange: setConversation,
		setNotice: noPresentation,
		isCurrent: () => !signal.aborted,
	};
	const requestSelection = async (conversationId: number, messageId: number, variantId: number) => {
		const requested = { messageId, request: { value: variantId } };
		const current = selections.get(signal) ?? { queued: false, requested: null };
		selections.set(signal, current);
		if (current.requested !== null) dispatchStory({ type: "selection-settled", ...current.requested, revision: null });
		current.requested = requested;
		dispatchStory({ type: "selection-requested", ...requested });
		if (current.queued) return;
		current.queued = true;
		let sent: RequestedSelection | undefined;
		const applied = await runConversationCommand({ ...surface, conversationId }, (expectedRevision) => {
			current.queued = false;
			sent = current.requested ?? requested;
			current.requested = null;
			return applyConversationCommand(conversationId, expectedRevision, {
				type: "select-variant", messageId: sent.messageId, variantId: sent.request.value,
			});
		}, {
			notices: STORY_COMMAND_NOTICES,
			onApplied: (result) => {
				if (sent !== undefined) dispatchStory({ type: "selection-settled", ...sent, revision: result.revision });
			},
		});
		if (applied || signal.aborted) return;
		const failed = sent ?? current.requested ?? requested;
		if (sent === undefined) {
			current.queued = false;
			current.requested = null;
		}
		dispatchStory({ type: "selection-settled", ...failed, revision: null });
	};

	const changeSwipe = async (messageId: number, direction: -1 | 1) => {
		const storyMessage = story.messages.find((entry) => entry.id === messageId);
		if (storyMessage === undefined) return;
		const shownId = displayedVariantId(story, storyMessage);
		const currentIndex = storyMessage.swipes.findIndex((variant) => variant.id === shownId);
		if (currentIndex === -1) return;
		const target = storyMessage.swipes[Math.min(storyMessage.swipes.length - 1, Math.max(0, currentIndex + direction))];
		if (target !== undefined) await selectSwipe(messageId, target.id);
	};

	const selectSwipe = async (messageId: number, variantId: number) => {
		const preview = story.preview;
		if (preview !== null) {
			if (preview.messageId !== messageId || preview.variantId === variantId) return;
			const message = story.messages.find((entry) => entry.id === messageId);
			if (!message?.swipes.some((variant) => variant.id === variantId)) return;
			queueSwipeScroll(messageId);
			dispatchStory({ type: "preview-changed", preview: previewOnMessage(message, variantId) });
			return;
		}
		if (!canEnterPreview) return;
		if (commandRevision() === null) return;

		const selection = classifyVariantSelection(story, messageId, variantId);
		if (selection.kind === "noop" || selection.kind === "blocked") return;
		if (selection.kind === "preview") {
			onEnterPreview(() => {
				queueSwipeScroll(messageId);
				dispatchStory({ type: "preview-changed", preview: { messageId, variantId } });
			});
			return;
		}

		if (!isStoryReady(story)) return;
		queueSwipeScroll(selection.messageId);
		await requestSelection(story.conversationId, selection.messageId, selection.variantId);
	};

	// @approved
	//  Saving as new copies the shown Variant, with its edited text, to a new
	// selected Swipe at the end and leaves the source untouched.
	const editStoryMessage = async (messageId: number, content: string, asNew: boolean) => {
		if (!isStoryReady(story) || story.preview !== null) return false;
		const storyMessage = story.messages.find((entry) => entry.id === messageId);
		if (storyMessage === undefined) return false;
		const variantId = shownVariant(story, storyMessage)?.id;
		const conversationId = story.conversationId;
		if (variantId === undefined) return false;

		let applied = false;
		await runConversationCommand({ ...surface, conversationId }, asNew
			? { type: "create-variant", messageId, sourceVariantId: variantId, content }
			: { type: "edit-variant", messageId, variantId, content }, {
			notices: STORY_COMMAND_NOTICES,
			onApplied: () => { applied = true; },
		});
		return applied;
	};

	const setMessageMoves = async (messageId: number, moves: BoxMoves) => {
		if (!isStoryReady(story) || story.preview !== null) return;
		const request = { value: moves };
		dispatchStory({ type: "moves-requested", messageId, request });
		const applied = await runConversationCommand({ ...surface, conversationId: story.conversationId }, { type: "set-message-moves", messageId, moves }, {
			notices: STORY_COMMAND_NOTICES,
			onApplied: (result) => dispatchStory({ type: "moves-settled", messageId, request, revision: result.revision }),
		});
		if (!applied && !signal.aborted) dispatchStory({ type: "moves-settled", messageId, request, revision: null });
	};

	const deleteStoryMessage = async (messageId: number) => {
		if (!isStoryReady(story) || story.preview !== null) return;
		const conversationId = story.conversationId;
		if (!story.messages.some((entry) => entry.id === messageId)) return;

		await runConversationCommand({ ...surface, conversationId }, {
			type: "delete-message",
			messageId,
		}, {
			notices: STORY_COMMAND_NOTICES,
		});
	};

	return { changeSwipe, selectSwipe, editStoryMessage, setMessageMoves, deleteStoryMessage };
}
