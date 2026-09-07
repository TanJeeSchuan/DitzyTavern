// ==[HUMAN APPROVED]== Focused UI-boundary presentation for the Prompt Preset library in the
// preset popup. These shape list labels, selection feedback, and deletion
// confirmation copy only; the library behavior itself lives behind the server
// seam. Transport stays out of this module so tests can import it without a
// browser.

// Short human label for the affected-Conversation count presented on every
// ==[HUMAN APPROVED]== library list row, so the deletion confirmation can state the exact
// consequence before any command is sent.
export function affectedConversationsLabel(count: number): string {
	if (count === 0) return "Not selected by any Chat";
	if (count === 1) return "Selected by 1 Chat";
	return `Selected by ${count} Chats`;
}

export interface PresetDeletionConfirmationCopy {
	title: string;
	impact: string;
	confirmLabel: string;
}

// The confirmation names exactly what deletion does: the affected
// ==[HUMAN APPROVED]== Conversations move to the Default preset in the same operation, and
// the Default preset itself can never be deleted.
export function presetDeletionConfirmationCopy(
	name: string,
	conversationCount: number,
): PresetDeletionConfirmationCopy {
	const title = `Delete ${name}?`;
	return {
		title,
		impact:
			`${affectedConversationsLabel(conversationCount)}. Deleting this preset removes it from the Library and moves every affected Chat to the Default preset. Nothing else in those Chats changes.`,
		confirmLabel: "Yes, delete preset",
	};
}

// The selected row's feedback label. The Default badge rides the same list
// ==[HUMAN APPROVED]== so the stable deletion destination stays recognizable.
export function presetSelectionFeedbackLabel(isSelected: boolean): string {
	return isSelected ? "Selected for this Chat" : "Select for this Chat";
}

// Success notice after a confirmed deletion. The typed result carries the
// ==[HUMAN APPROVED]== derived reassignment, so the wording matches what the server
// actually did: affected Chats landed on the Default preset, and nothing
// else in them changed.
export function presetDeletionResultNotice(
	name: string,
	result: { reassignedConversationCount: number },
): string {
	const moved = result.reassignedConversationCount === 0
		? "No Chat was using it."
		: result.reassignedConversationCount === 1
			? "1 Chat moved to the Default preset."
			: `${result.reassignedConversationCount} Chats moved to the Default preset.`;
	return `Deleted "${name}". ${moved}`;
}
