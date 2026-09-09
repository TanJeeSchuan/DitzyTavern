// ==[HUMAN APPROVED]== Focused UI-boundary presentation for the Prompt Preset library in the
// preset popup. These shape list labels, selection feedback, deletion
// confirmation copy, and the recipe vocabulary shared by the recipe editor
// and the import review; the library behavior itself lives behind the server
// seam. Transport stays out of this module so tests can import it without a
// browser.

import type { PromptOutgoingRole, PromptPresetBlockReference } from "../shared/contract/prompt-preset";

// ==[HUMAN APPROVED]== One vocabulary for both the recipe editor and the SillyTavern import
// review, so a slot label or outgoing-role label can never drift between
// them.
export const slotLabels = {
	"model-system-instruction": "System Instruction",
	"human-identity": "Identity (you)",
	"model-identity": "Identity (character)",
	"model-scenario": "Scenario",
	"model-example-dialogue": "Example Dialogue",
	history: "Chat history",
	"model-post-history-instruction": "Post-History Instruction",
	instruction: "Instruction",
} as const satisfies Record<PromptPresetBlockReference, string>;

export const outgoingRoleLabels = {
	system: "System message",
	user: "User message",
	assistant: "Assistant message",
} as const satisfies Record<PromptOutgoingRole, string>;

type TitledSlot =
	| { reference: "instruction"; name: string }
	| { reference: Exclude<PromptPresetBlockReference, "instruction"> };

// ==[HUMAN APPROVED]== An authored instruction titles itself with its own name and falls back to
// the reference label when that name is blank; every other slot shows the
// reference label.
export const slotTitle = (slot: TitledSlot): string =>
	slot.reference === "instruction" && slot.name.trim() !== ""
		? slot.name
		: slotLabels[slot.reference];

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

// ==[HUMAN APPROVED]== The notice after a deletion is rejected because the affected-Conversation
// count changed: nothing was deleted, and the current impact is stated before
// the author confirms again.
export function presetDeletionImpactChangedNotice(
	name: string,
	conversationCount: number,
): string {
	return `Deletion impact changed: ${affectedConversationsLabel(conversationCount)}. Confirm deletion again to remove "${name}".`;
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
