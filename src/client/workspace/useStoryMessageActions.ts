import type { Dispatch } from "react";
import {
	type ConversationSummary,
} from "../conversation";
import { runConversationCommand } from "../conversation-command-runner";
import {
	classifyVariantSelection,
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

type StoryMessageActionsOptions = {
	signal: AbortSignal;
	refreshHistoryPage: (messageId: number) => Promise<void>;
	story: StoryState;
	conversation: ConversationSummary | null;
	dispatchStory: Dispatch<StoryAction>;
	setConversation: (conversation: ConversationSummary | null) => void;
	queueSwipeScroll: (messageId: number) => void;
	clearPreviewError: () => void;
	canEnterPreview: boolean;
	onEnterPreview: () => void;
};

/** @approved
 * Coordinates user commands that mutate or preview a story Message. Preview
 * state is immediate local presentation; a selected Variant moves the story
 * read model only after the server applies the command, so a failed Swipe
 * never diverges the two state owners. This hook owns the server command,
 * and the runner owns revision acquisition, exception normalization, and
 * common reconciliation. The edit command keeps its operation-specific
 * history refresh for the edited Message without replacing the reading window.
 */
export function useStoryMessageActions({
	signal,
	refreshHistoryPage,
	story,
	conversation,
	dispatchStory,
	setConversation,
	queueSwipeScroll,
	clearPreviewError,
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

	const changeSwipe = async (messageId: number, direction: -1 | 1) => {
		const storyMessage = story.messages.find((entry) => entry.id === messageId);
		if (storyMessage === undefined) return;
		const preview = story.preview;
		if (preview !== null && preview.messageId !== messageId) return;

		const currentIndex = preview !== null
			? storyMessage.swipes.findIndex((variant) => variant.id === preview.variantId)
			: storyMessage.activeSwipe;
		if (currentIndex === -1) return;
		const targetIndex = Math.min(
			storyMessage.swipes.length - 1,
			Math.max(0, currentIndex + direction),
		);
		const target = storyMessage.swipes[targetIndex];
		if (target === undefined) return;

		if (preview !== null) {
			queueSwipeScroll(messageId);
			clearPreviewError();
			dispatchStory({ type: "preview-retargeted", messageId, variantId: target.id });
			return;
		}
		if (!canEnterPreview) return;
		if (conversation === null) return;

		const selection = classifyVariantSelection(story, messageId, target.id);
		if (selection.kind === "noop" || selection.kind === "blocked") return;
		if (selection.kind === "preview") {
			onEnterPreview();
			clearPreviewError();
			queueSwipeScroll(messageId);
			dispatchStory({
				type: "preview-started",
				messageId: selection.messageId,
				variantId: selection.variantId,
			});
			return;
		}

		const conversationId = story.conversationId;
		if (conversationId === null) return;

		await runConversationCommand(surface, {
			type: "select-variant",
			messageId: selection.messageId,
			variantId: selection.variantId,
		}, {
			notices: STORY_COMMAND_NOTICES,
			onApplied: () => {
				queueSwipeScroll(selection.messageId);
				dispatchStory({
					type: "swipe-selected",
					messageId: selection.messageId,
					variantId: selection.variantId,
				});
			},
		});
	};

	const editStoryMessage = async (messageId: number, content: string) => {
		if (story.preview !== null) return;
		const storyMessage = story.messages.find((entry) => entry.id === messageId);
		if (storyMessage === undefined) return;
		const variantId = storyMessage.swipes[storyMessage.activeSwipe]?.id;
		const conversationId = story.conversationId;
		if (variantId === undefined || conversationId === null) return;

		await runConversationCommand(surface, {
			type: "edit-variant",
			messageId,
			variantId,
			content,
		}, {
			notices: STORY_COMMAND_NOTICES,
			onApplied: () => { void refreshHistoryPage(messageId); },
		});
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
			onApplied: (applied) => dispatchStory({
				type: "message-deleted",
				messageId,
				revision: applied.revision,
			}),
		});
	};

	return { changeSwipe, editStoryMessage, deleteStoryMessage };
}
