import type { Dispatch } from "react";
import {
	type ConversationSummary,
} from "../conversation";
import { runConversationCommand } from "../conversation-command-runner";
import {
	type StoryAction,
	type StoryState,
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
		conversationId: story.conversationId,
		revision: () => conversation?.revision ?? story.revision,
		onConversationChange: setConversation,
		setNotice: () => undefined,
		isCurrent: () => !signal.aborted,
	};

	const cancelPreview = () => dispatchStory({ type: "preview-cancelled" });

	const confirmPreview = async () => {
		const preview = story.preview;
		if (preview === null || story.conversationId === null) return;
		const { messageId, variantId } = preview;
		dispatchStory({ type: "preview-confirmed" });
		const applied = await runConversationCommand(surface, { type: "select-variant", messageId, variantId }, {
			onApplied: () => dispatchStory({ type: "swipe-selected", messageId, variantId }),
		});
		if (!applied && !signal.aborted) dispatchStory({ type: "selection-dropped", messageId });
	};

	return { cancelPreview, confirmPreview };
}
