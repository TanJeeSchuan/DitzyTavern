import type { Dispatch } from "react";
import { chatHistoryTransport } from "../chat-history";
import {
	applyConversationCommand,
	type ConversationSummary,
} from "../conversation";
import { runConversationCommand } from "../conversation-command-runner";
import {
	classifyVariantSelection,
	deriveRevisionWindow,
	type StoryAction,
	type StoryState,
} from "../story";

// ==[HUMAN APPROVED]== The story stage has no command-notice surface: a failed command leaves the
// reading view untouched and the next authoritative read converges it. The
// runner still refuses to send without a revision and normalizes exceptions;
// this surface's adapter simply chooses silence for the standard notices.
const STORY_COMMAND_NOTICES = {
	conflict: "The Conversation changed elsewhere; the current state was loaded.",
	notFound: "The Conversation no longer exists.",
	unreachable: "The Conversation could not be reached.",
};

// ==[HUMAN APPROVED]== The story's no-presentation decision for the precise Conversation-state
// outcomes, made explicit so the runner never flattens them for this surface.
const noPresentation = () => undefined;

type StoryMessageActionsOptions = {
	story: StoryState;
	conversation: ConversationSummary | null;
	dispatchStory: Dispatch<StoryAction>;
	setConversation: (conversation: ConversationSummary | null) => void;
	queueSwipeScroll: (messageId: number) => void;
	clearPreviewError: () => void;
	onEnterPreview: () => void;
};

/**
 * ==[HUMAN APPROVED]== Coordinates user commands that mutate or preview a story Message. Preview
 * state is immediate local presentation; a selected Variant moves the story
 * read model only after the server applies the command, so a failed Swipe
 * never diverges the two state owners. This hook owns the server command,
 * and the runner owns revision acquisition, exception normalization, and
 * common reconciliation. The edit command keeps its operation-specific
 * first-page history refresh.
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

		const conversationId = story.conversationId;
		if (conversationId === null) return;

		await runConversationCommand({
			revision: () => conversation.revision,
			send: (expectedRevision) =>
				applyConversationCommand(conversationId, expectedRevision, {
					type: "select-variant",
					messageId: selection.messageId,
					variantId: selection.variantId,
				}),
			reconciliation: {
				adoptSnapshot: setConversation,
				showNotice: noPresentation,
			},
			notices: STORY_COMMAND_NOTICES,
			// ==[HUMAN APPROVED]== Update-after-success: the story read model moves only once the
			// command applied, so a failed or conflicted Swipe leaves the story
			// exactly as the Conversation state is — nothing to roll back.
			callbacks: {
				onApplied: () => {
					queueSwipeScroll(selection.messageId);
					dispatchStory({
						type: "swipe-selected",
						messageId: selection.messageId,
						variantId: selection.variantId,
					});
				},
				onNotPlayable: noPresentation,
				onNotRemovable: noPresentation,
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

		await runConversationCommand({
			revision: () => conversation?.revision ?? story.revision,
			send: (expectedRevision) =>
				applyConversationCommand(conversationId, expectedRevision, {
					type: "edit-variant",
					messageId,
					variantId,
					content,
				}),
			reconciliation: {
				adoptSnapshot: setConversation,
				showNotice: noPresentation,
			},
			notices: STORY_COMMAND_NOTICES,
			callbacks: {
				onApplied: () => {
					// ==[HUMAN APPROVED]== Reload the first page so authoritative content replaces the
					// local edit without drifting from the server's read model.
					void chatHistoryTransport
						.loadHistory(conversationId, { page: 1 })
						.then((freshHistory) => {
							if (freshHistory.status === "available") {
								dispatchStory({ type: "first-page", page: freshHistory.page });
							}
						});
				},
				onNotPlayable: noPresentation,
				onNotRemovable: noPresentation,
			},
		});
	};

	return { changeSwipe, editStoryMessage };
}
