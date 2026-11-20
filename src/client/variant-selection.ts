import type { Dispatch } from "react";
import { applyConversationCommand, type ConversationSummary } from "./conversation";
import { runConversationCommand } from "./conversation-command-runner";
import { classifyVariantSelection, isStoryReady, type RequestedWrite, type StoryAction, type StoryState } from "./story";

export type VariantSelectionSurface = {
	signal: AbortSignal;
	story: StoryState;
	dispatchStory: Dispatch<StoryAction>;
	setConversation: (conversation: ConversationSummary | null) => void;
};

export type SelectionHistory = (minimumRevision: number) => Promise<StoryState>;
type SelectionMode = { kind: "confirm" } | { kind: "swipe"; waitForHistory: SelectionHistory };
type RequestedSelection = { baseRevision: number; confirmed: boolean; messageId: number; request: RequestedWrite<number> };
type SelectionSlot = { selection: RequestedSelection; claimed: boolean };
const selections = new WeakMap<AbortSignal, SelectionSlot>();

export async function requestVariantSelection(
	{ signal, story, dispatchStory, setConversation }: VariantSelectionSurface,
	messageId: number,
	variantId: number,
	mode: SelectionMode,
) {
	if (signal.aborted || !isStoryReady(story)) return;
	const confirmed = mode.kind === "confirm";
	const conversationId = story.conversationId;
	const baseRevision = story.revision;
	const surface = { exact: !confirmed, onConversationChange: setConversation, setNotice: () => {}, isCurrent: () => !signal.aborted };
	const requested = { baseRevision, messageId, confirmed, request: { value: variantId } };
	const previousSlot = selections.get(signal);
	if (previousSlot !== undefined && !previousSlot.claimed && !confirmed && !previousSlot.selection.confirmed) {
		dispatchStory({ type: "selection-settled", ...previousSlot.selection, revision: null });
		previousSlot.selection = requested;
		dispatchStory({ type: "selection-requested", ...requested });
		return;
	}
	const slot: SelectionSlot = { selection: requested, claimed: false };
	selections.set(signal, slot);
	dispatchStory({ type: confirmed ? "preview-confirmed" : "selection-requested", ...requested });
	try {
		const applied = await runConversationCommand({ ...surface, conversationId, revision: async (previous, queued) => {
			if (mode.kind === "confirm") return baseRevision;
			const needsHistory = previousSlot !== undefined || queued;
			const refreshed = needsHistory ? await mode.waitForHistory(previous ?? 0).catch(() => undefined) : null;
			slot.claimed = true;
			const { baseRevision: selectionRevision, messageId, request } = slot.selection;
			if (refreshed === null) return selectionRevision;
			if (refreshed === undefined || !isStoryReady(refreshed) || refreshed.revision < selectionRevision) return null;
			const persisted = { ...refreshed, requestedSelections: new Map() };
			const selection = classifyVariantSelection(persisted, messageId, request.value);
			return selection.kind === "immediate" ? refreshed.revision : null;
		} }, (expectedRevision) => {
			const { messageId, request } = slot.selection;
			return applyConversationCommand(conversationId, expectedRevision, { type: "select-variant", messageId, variantId: request.value });
		}, {
			onApplied: ({ revision }) => dispatchStory({ type: "selection-settled", ...slot.selection, revision }),
		});
		if (!applied && !signal.aborted) dispatchStory({ type: "selection-settled", ...slot.selection, revision: null });
	} finally {
		if (selections.get(signal) === slot) selections.delete(signal);
	}
}
