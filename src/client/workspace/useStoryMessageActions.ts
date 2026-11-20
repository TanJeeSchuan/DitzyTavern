import type { BoxMoves } from "../../shared/contract/box-generation";
import type { Dispatch } from "react";
import {
	applyConversationCommand,
	type ConversationSummary,
} from "../conversation";
import { runConversationCommand } from "../conversation-command-runner";
import {
	classifyVariantSelection,
	canWriteMessage,
	displayedVariantId,
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

type RequestedSelection = { baseRevision: number; messageId: number; request: RequestedWrite<number> };
type SelectionSlot = { selection: RequestedSelection; claimed: boolean };
const selections = new WeakMap<AbortSignal, SelectionSlot>();

type StoryMessageActionsOptions = {
	signal: AbortSignal;
	story: StoryState;
	dispatchStory: Dispatch<StoryAction>;
	setConversation: (conversation: ConversationSummary | null) => void;
	waitForHistory: (minimumRevision?: number) => Promise<StoryState>;
	queueSwipeScroll: (messageId: number) => void;
	canEnterPreview: boolean;
	onEnterPreview: (enter: () => void) => void;
};

export function useStoryMessageActions({
	signal,
	story,
	dispatchStory,
	setConversation,
	waitForHistory,
	queueSwipeScroll,
	canEnterPreview,
	onEnterPreview,
}: StoryMessageActionsOptions) {
	const surface = {
		exact: true,
		onConversationChange: setConversation,
		setNotice: noPresentation,
		isCurrent: () => !signal.aborted,
	};
	const messageForWrite = (messageId: number, revision: number) => {
		if (!isStoryReady(story) || story.revision !== revision || !canWriteMessage(story, messageId)) return undefined;
		const message = story.messages.find((entry) => entry.id === messageId);
		return message === undefined ? undefined : { message, commandSurface: { ...surface, conversationId: story.conversationId, revision: () => revision } };
	};
	const requestSelection = async (conversationId: number, messageId: number, variantId: number, baseRevision: number) => {
		const requested = { baseRevision, messageId, request: { value: variantId } };
		const previousSlot = selections.get(signal);
		if (previousSlot !== undefined && !previousSlot.claimed) {
			dispatchStory({ type: "selection-settled", ...previousSlot.selection, revision: null });
			previousSlot.selection = requested;
			dispatchStory({ type: "selection-requested", ...requested });
			return;
		}
		const slot: SelectionSlot = { selection: requested, claimed: false };
		selections.set(signal, slot);
		dispatchStory({ type: "selection-requested", ...requested });
		try {
			const applied = await runConversationCommand({ ...surface, conversationId, revision: async (previous) => {
				const minimum = previous ?? 0;
				const needsHistory = previousSlot !== undefined || minimum > slot.selection.baseRevision;
				const refreshed = needsHistory ? await waitForHistory(minimum).catch(() => undefined) : null;
				slot.claimed = true;
				const { baseRevision, messageId, request } = slot.selection;
				if (refreshed === null) return baseRevision;
				if (refreshed === undefined || !isStoryReady(refreshed) || refreshed.revision < baseRevision) return null;
				const persisted = { ...refreshed, requestedSelections: new Map() };
				const selection = classifyVariantSelection(persisted, messageId, request.value);
				return selection.kind === "immediate" ? refreshed.revision : null;
			} }, (expectedRevision) => {
				const { messageId, request } = slot.selection;
				return applyConversationCommand(conversationId, expectedRevision, { type: "select-variant", messageId, variantId: request.value });
			}, {
				notices: STORY_COMMAND_NOTICES,
				onApplied: ({ revision }) => dispatchStory({ type: "selection-settled", ...slot.selection, revision }),
			});
			if (!applied && !signal.aborted) dispatchStory({ type: "selection-settled", ...slot.selection, revision: null });
		} finally {
			if (selections.get(signal) === slot) selections.delete(signal);
		}
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
		if (!isStoryReady(story)) return;

		const selection = classifyVariantSelection(story, messageId, variantId);
		if (selection.kind === "noop" || selection.kind === "blocked") return;
		if (selection.kind === "preview") {
			onEnterPreview(() => {
				queueSwipeScroll(messageId);
				dispatchStory({ type: "preview-changed", preview: { messageId, variantId } });
			});
			return;
		}

		queueSwipeScroll(selection.messageId);
		await requestSelection(story.conversationId, selection.messageId, selection.variantId, story.revision);
	};

	// @approved
	//  Saving as new copies the selected Variant, with its edited text, to a new
	// selected Swipe at the end and leaves the source untouched.
	const editStoryMessage = async (messageId: number, variantId: number, content: string, asNew: boolean, baseRevision: number) => {
		const write = messageForWrite(messageId, baseRevision);
		if (write === undefined) return false;
		const { message, commandSurface } = write;
		if (message.swipes[message.activeSwipe]?.id !== variantId) return false;

		let applied = false;
		await runConversationCommand(commandSurface, asNew
			? { type: "create-variant", messageId, sourceVariantId: variantId, content }
			: { type: "edit-variant", messageId, variantId, content }, {
			notices: STORY_COMMAND_NOTICES,
			onApplied: () => { applied = true; },
		});
		return applied;
	};

	const setMessageMoves = async (messageId: number, moves: BoxMoves, baseRevision: number) => {
		const write = messageForWrite(messageId, baseRevision);
		if (write === undefined) return;
		const request = { value: moves };
		dispatchStory({ type: "moves-requested", messageId, request });
		const applied = await runConversationCommand(write.commandSurface, { type: "set-message-moves", messageId, moves }, {
			notices: STORY_COMMAND_NOTICES,
			onApplied: (result) => dispatchStory({ type: "moves-settled", messageId, request, revision: result.revision }),
		});
		if (!applied && !signal.aborted) dispatchStory({ type: "moves-settled", messageId, request, revision: null });
	};

	const deleteStoryMessage = async (messageId: number, baseRevision: number) => {
		const write = messageForWrite(messageId, baseRevision);
		if (write === undefined) return;
		await runConversationCommand(write.commandSurface, {
			type: "delete-message",
			messageId,
		}, {
			notices: STORY_COMMAND_NOTICES,
			onApplied: () => dispatchStory({ type: "inline-draft-changed", messageId, draft: undefined }),
		});
	};

	return { changeSwipe, selectSwipe, editStoryMessage, setMessageMoves, deleteStoryMessage };
}
