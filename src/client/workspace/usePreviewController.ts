import type { Dispatch } from "react";
import {
	type ConversationSummary,
} from "../conversation";
import { runConversationCommand } from "../conversation-command-runner";
import {
	type StoryAction,
	type StoryState,
	isStoryReady,
} from "../story";

type PreviewControllerOptions = {
	// The Chat visit's signal: a confirmation settling after the writer left never touches a later visit.
	signal: AbortSignal;
	story: StoryState;
	conversation: ConversationSummary | null;
	dispatchStory: Dispatch<StoryAction>;
	setConversation: (conversation: ConversationSummary | null) => void;
};

/**
 * Owns the local Preview transaction. Confirm Change ends Preview at once and shows the previewed Variant as a
 * Requested selection; if the revision-guarded command does not apply, the server's selection shows again.
 */
export function usePreviewController({
	signal,
	story,
	conversation,
	dispatchStory,
	setConversation,
}: PreviewControllerOptions) {
	const surface = {
		revision: () => conversation?.revision ?? (isStoryReady(story) ? story.revision : null),
		onConversationChange: setConversation,
		setNotice: () => undefined,
		isCurrent: () => !signal.aborted,
	};

	const cancelPreview = () => dispatchStory({ type: "preview-changed", preview: null });

	const confirmPreview = async () => {
		const preview = story.preview;
		if (preview === null || !isStoryReady(story)) return;
		const { messageId, variantId } = preview;
		const request = { value: variantId, appliedRevision: null };
		dispatchStory({ type: "preview-confirmed", messageId, request });
		const applied = await runConversationCommand({ ...surface, conversationId: story.conversationId }, { type: "select-variant", messageId, variantId }, {
			onApplied: (result) => dispatchStory({ type: "selection-settled", messageId, request, revision: result.revision }),
		});
		if (!applied && !signal.aborted) dispatchStory({ type: "selection-settled", messageId, request, revision: null });
	};

	return { cancelPreview, confirmPreview };
}
