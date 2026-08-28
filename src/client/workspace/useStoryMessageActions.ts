import type { Dispatch, SetStateAction } from "react";
import { chatHistoryTransport } from "../chat-history";
import {
	applyConversationCommand,
	loadConversation,
	type ConversationSummary,
} from "../conversation";
import {
	classifyVariantSelection,
	deriveRevisionWindow,
	type StoryAction,
	type StoryState,
} from "../story";

type StoryMessageActionsOptions = {
	story: StoryState;
	conversation: ConversationSummary | null;
	dispatchStory: Dispatch<StoryAction>;
	setConversation: Dispatch<SetStateAction<ConversationSummary | null>>;
	queueSwipeScroll: (messageId: number) => void;
	clearPreviewError: () => void;
	onEnterPreview: () => void;
};

/**
 * Coordinates user commands that mutate or preview a story Message. The
 * reducer owns immediate presentation state; this hook owns the server
 * command, revision recovery, and the UI transition into Preview mode.
 */
export function useStoryMessageActions({
	story,
	conversation,
	dispatchStory,
	setConversation,
	queueSwipeScroll,
	clearPreviewError,
	onEnterPreview,
}: StoryMessageActionsOptions) {
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
		if (conversation === null) return;

		const revisionWindow = deriveRevisionWindow(
			story.messages,
			conversation.control.modelParticipantId,
		);
		const selection = classifyVariantSelection(
			story,
			messageId,
			target.id,
			revisionWindow,
		);
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

		queueSwipeScroll(messageId);
		dispatchStory({
			type: "swipe-selected",
			messageId: selection.messageId,
			variantId: selection.variantId,
		});
		const conversationId = story.conversationId;
		if (conversationId === null) return;
		const expectedRevision = conversation.revision ?? story.revision ?? -1;
		if (expectedRevision < 0) return;

		const outcome = await applyConversationCommand(conversationId, expectedRevision, {
			type: "select-variant",
			messageId: selection.messageId,
			variantId: selection.variantId,
		});
		if (outcome.status === "applied") {
			setConversation(outcome.conversation);
			return;
		}
		if (outcome.status === "conflict") {
			setConversation(outcome.currentConversation);
		}
		const fresh = await loadConversation(conversationId);
		if (fresh !== null) setConversation(fresh);
	};

	const editStoryMessage = async (messageId: number, content: string) => {
		if (story.preview !== null) return;
		const storyMessage = story.messages.find((entry) => entry.id === messageId);
		if (storyMessage === undefined) return;
		const variantId = storyMessage.swipes[storyMessage.activeSwipe]?.id;
		const conversationId = story.conversationId;
		if (variantId === undefined || conversationId === null) return;
		const expectedRevision = conversation?.revision ?? story.revision ?? -1;
		if (expectedRevision < 0) return;

		const outcome = await applyConversationCommand(conversationId, expectedRevision, {
			type: "edit-variant",
			messageId,
			variantId,
			content,
		});
		if (outcome.status === "applied") {
			setConversation(outcome.conversation);
			// Reload the first page so authoritative content replaces the local
			// edit without drifting from the server's read model.
			const freshHistory = await chatHistoryTransport.loadHistory(conversationId, {
				page: 1,
			});
			if (freshHistory.status === "available") {
				dispatchStory({ type: "first-page", page: freshHistory.page });
			}
			return;
		}
		if (outcome.status === "conflict") {
			setConversation(outcome.currentConversation);
		}
		const fresh = await loadConversation(conversationId);
		if (fresh !== null) setConversation(fresh);
	};

	return { changeSwipe, editStoryMessage };
}
