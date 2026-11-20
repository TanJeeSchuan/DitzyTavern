import { hasMoves } from "../../shared/contract/box-generation";
import { useSaveGuard } from "../SaveGuard";
import { canWriteMessage, displayedVariantId, isStoryReady, type InlineMessageDraft, type StoryAction, type StoryState, type StoryVariant } from "../story";
import type { ConversationSummary } from "../conversation";
import type { Dispatch } from "react";
import type { useStoryMessageActions } from "./useStoryMessageActions";

export const inlineDraftScope = (messageId: number) => `inline-draft:${messageId}`;

export function InlineMessageDraftGuard({ messageId, draft, canSave, save, discard, waitForHistory }: {
	messageId: number;
	draft: InlineMessageDraft;
	canSave: boolean;
	save: (messageId: number, asNew: boolean) => Promise<boolean>;
	discard: (messageId: number) => void;
	waitForHistory: () => Promise<void>;
}) {
	useSaveGuard({
		chatDraft: true,
		dirty: draft.asNew || draft.text !== draft.baseContent,
		saving: draft.saving,
		canSave,
		save: () => save(messageId, draft.asNew),
		discard: () => discard(messageId),
		waitAfterSave: waitForHistory,
	}, inlineDraftScope(messageId));
	return null;
}

export function inlineMessageDrafts({
	story, conversation, isGenerating, dispatchStory, editStoryMessage,
}: {
	story: StoryState;
	conversation: ConversationSummary | null;
	isGenerating: boolean;
	dispatchStory: Dispatch<StoryAction>;
	editStoryMessage: ReturnType<typeof useStoryMessageActions>["editStoryMessage"];
}) {
	const set = (messageId: number, draft: InlineMessageDraft | undefined, expected?: InlineMessageDraft) =>
		dispatchStory({ type: "inline-draft-changed", messageId, draft, expected });
	const open = (messageId: number, selected: StoryVariant, revision: number) => {
		if (story.inlineDrafts.has(messageId) || selected.content === null) return;
		set(messageId, { variantId: selected.id, baseRevision: revision, baseContent: selected.content, text: selected.content, asNew: false, saving: false });
	};
	const write = (messageId: number, asNew: boolean) => {
		const draft = story.inlineDrafts.get(messageId);
		if (draft === undefined || !isStoryReady(story) ||
			!canWriteMessage(story, messageId) || (conversation !== null && story.revision < conversation.revision) ||
			(asNew && isGenerating)) return;
		const message = story.messages.find((message) => message.id === messageId);
		const selected = message?.swipes[message.activeSwipe];
		if (message === undefined || selected?.content == null) return;
		const generating = conversation?.activeGenerations.some(({ messageId: id, variantId }) => id === messageId && variantId === displayedVariantId(story, message));
		if (generating || (draft.text.trim() === "" && !(asNew && draft.text === draft.baseContent) && !hasMoves(message.moves))) return;
		return { draft, selected, content: selected.content, revision: story.revision };
	};
	const save = async (messageId: number, asNew: boolean, displayedRevision?: number) => {
		const current = write(messageId, asNew);
		if (current === undefined || (displayedRevision !== undefined && displayedRevision !== current.revision)) return false;
		const { draft, selected, content, revision } = current;
		const editing = { ...draft, asNew };
		const revalidate = displayedRevision === undefined;
		if (selected.id !== draft.variantId) {
			set(messageId, { ...editing, acknowledged: undefined, conflict: "Changed elsewhere. Select the Swipe you edited before saving." });
			return false;
		}
		const confirmed = !revalidate && draft.acknowledged?.revision === revision && draft.acknowledged.content === content && draft.acknowledged.asNew === asNew;
		if (!confirmed && content !== draft.baseContent && (!asNew || !revalidate)) {
			const conflict = revalidate ? "Changed elsewhere. Review this draft before saving."
				: asNew ? "Changed elsewhere. Save as new Swipe again to keep both versions." : "Changed elsewhere. Save again to overwrite.";
			const acknowledged = revalidate ? draft.acknowledged : { revision, content, asNew };
			set(messageId, { ...editing, conflict, acknowledged });
			return false;
		}
		const saving = { ...editing, saving: true };
		set(messageId, saving);
		const value = asNew && draft.text === draft.baseContent ? draft.baseContent : draft.text.trim();
		let applied = false;
		try {
			applied = await editStoryMessage(messageId, draft.variantId, value, asNew, revision);
			return applied;
		} finally {
			set(messageId, applied ? undefined : editing, saving);
		}
	};
	return {
		open, save,
		canSave: (messageId: number, asNew: boolean) => write(messageId, asNew) !== undefined,
		setText: (messageId: number, text: string) => {
			const draft = story.inlineDrafts.get(messageId);
			if (draft !== undefined && !draft.saving && draft.text !== text) set(messageId, { ...draft, text });
		},
		discard: (messageId: number) => set(messageId, undefined),
	};
}
