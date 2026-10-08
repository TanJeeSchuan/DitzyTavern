import { useEffect, useRef, useState, type Dispatch } from "react";
import {
	type ConversationSummary,
} from "../conversation";
import { useConversationCommands } from "../useConversationCommands";
import {
	confirmPreviewSelection,
	type StoryAction,
	type StoryState,
} from "../story";

// @approved
//  The wording this surface shows for each standard command failure. Preview
// mode stays local on conflict: the runner never touches the story's preview
// state, so the notice only has to say what the writer still controls.
const PREVIEW_NOTICES = {
	conflict:
		"The Conversation changed elsewhere. Preview remains local until you confirm or cancel it.",
	notFound: "The Conversation no longer exists.",
	unreachable: "The Conversation could not be reached.",
};

type PreviewControllerOptions = {
	story: StoryState;
	conversation: ConversationSummary | null;
	dispatchStory: Dispatch<StoryAction>;
	setConversation: (conversation: ConversationSummary | null) => void;
};

/** ==[HUMAN APPROVED]== Owns the local Preview transaction and its revision-guarded confirmation. */
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

	const { run } = useConversationCommands(story.conversationId, { revision: () => conversation?.revision ?? story.revision, onConversationChange: setConversation, setNotice: setPreviewError });

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

		previewConfirmInFlightRef.current = true;
		setPreviewPending(true);
		setPreviewError(null);
		try {
			// @approved
			//  The transport boundary refuses to send without the matching
			// client preview; the runner refuses to send without an
			// authoritative revision and owns every outcome afterwards.
			await confirmPreviewSelection(
				preview,
				{
					conversationId,
					messageId: preview.messageId,
					variantId: preview.variantId,
				},
				async (selection) => {
					await run({
								type: "select-variant",
								messageId: selection.messageId,
								variantId: selection.variantId,
							}, { notices: PREVIEW_NOTICES, onNotPlayable: setPreviewError, onNotRemovable: setPreviewError,
				onApplied: () => dispatchStory({ type: "preview-confirmed" }) });
				},
			);
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
