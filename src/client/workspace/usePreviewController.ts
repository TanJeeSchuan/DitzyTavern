import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
	applyConversationCommand,
	type ConversationSummary,
} from "../conversation";
import {
	confirmPreviewSelection,
	type StoryAction,
	type StoryPreviewState,
	type StoryState,
} from "../story";

type PreviewControllerOptions = {
	story: StoryState;
	conversation: ConversationSummary | null;
	dispatchStory: Dispatch<StoryAction>;
	setConversation: Dispatch<SetStateAction<ConversationSummary | null>>;
};

/** Owns the local Preview transaction and its revision-guarded confirmation. */
export function usePreviewController({
	story,
	conversation,
	dispatchStory,
	setConversation,
}: PreviewControllerOptions) {
	const [previewPending, setPreviewPending] = useState(false);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const previewConfirmInFlightRef = useRef(false);

	useEffect(() => {
		if (story.preview !== null) return;
		setPreviewPending(false);
		setPreviewError(null);
		previewConfirmInFlightRef.current = false;
	}, [story.preview]);

	const clearPreviewError = () => setPreviewError(null);

	const cancelPreview = () => {
		if (previewPending) return;
		setPreviewError(null);
		dispatchStory({ type: "preview-cancelled" });
	};

	const confirmPreview = async () => {
		const preview = story.preview;
		const conversationId = story.conversationId;
		if (preview === null || conversationId === null || previewConfirmInFlightRef.current) {
			return;
		}
		const expectedRevision = conversation?.revision ?? story.revision ?? -1;
		if (expectedRevision < 0) {
			setPreviewError("The Conversation revision is not available yet.");
			return;
		}

		previewConfirmInFlightRef.current = true;
		setPreviewPending(true);
		setPreviewError(null);
		const request = {
			conversationId,
			expectedRevision,
			messageId: preview.messageId,
			variantId: preview.variantId,
		};
		try {
			const result = await confirmPreviewSelection(
				preview,
				request,
				async (selection) =>
					applyConversationCommand(selection.conversationId, selection.expectedRevision, {
						type: "select-variant",
						messageId: selection.messageId,
						variantId: selection.variantId,
					}),
			);
			if (result.status === "not-sent") return;
			const outcome = result.result;
			if (outcome.status === "applied") {
				setConversation(outcome.conversation);
				dispatchStory({ type: "preview-confirmed" });
				return;
			}
			if (outcome.status === "conflict") {
				setConversation(outcome.currentConversation);
				setPreviewError(
					"The Conversation changed elsewhere. Preview remains local until you confirm or cancel it.",
				);
				return;
			}
			if (outcome.status === "not-found") {
				setPreviewError("The Conversation no longer exists.");
				return;
			}
			setPreviewError(
				outcome.status === "network"
					? "The Conversation could not be reached."
					: outcome.reason,
			);
		} catch {
			setPreviewError("The Conversation could not be reached.");
		} finally {
			previewConfirmInFlightRef.current = false;
			setPreviewPending(false);
		}
	};

	return {
		previewPending,
		previewError,
		clearPreviewError,
		cancelPreview,
		confirmPreview,
	};
}
