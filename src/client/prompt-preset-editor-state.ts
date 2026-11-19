import {
	isAuthoredTextSlot,
	type ConversationPromptPreset,
	type PromptOutgoingRole,
	type PromptPresetBlockPatch,
	type ResolvedPromptPresetSlot,
} from "../shared/contract/prompt-preset";

export type BlockDraft =
	| { kind: "enabled"; enabled: boolean }
	| { kind: "role"; role: PromptOutgoingRole; enabled?: boolean }
	| { kind: "content"; name?: string; content: string; role: PromptOutgoingRole; enabled?: boolean };

// @approved
//  One slot-kind-safe draft-to-patch rule. Every block accepts
// enablement; referenced Definition and Lore blocks also accept role drafts,
// Box blocks accept instruction and role drafts, and authored instructions
// accept name, text and role drafts. The same rule drives dirtiness, batch
// building and submitted-version retirement.
export function draftToPatch(
	slot: ResolvedPromptPresetSlot,
	draft: BlockDraft,
): PromptPresetBlockPatch | null {
	if (draft.kind === "enabled") return draft.enabled === slot.enabled
		? null
		: { occurrenceId: slot.id, type: "enabled", enabled: draft.enabled };
	const enabledChanged = draft.enabled !== undefined && draft.enabled !== slot.enabled;
	if (slot.reference === "history") return null;
	if (isAuthoredTextSlot(slot)) {
		if (draft.kind !== "content") return null;
		const { content, role } = draft;
		const name = slot.reference === "instruction" ? draft.name ?? slot.name : undefined;
		const nameChanged = slot.reference === "instruction" && name !== slot.name;
		if (!nameChanged && content === slot.content && role === slot.role && !enabledChanged) return null;
		const patch: PromptPresetBlockPatch = { occurrenceId: slot.id, type: "content", content, role };
		if (name !== undefined) patch.name = name;
		if (enabledChanged) patch.enabled = draft.enabled;
		return patch;
	}
	if (draft.kind !== "role") return null;
	if (draft.role === slot.role && !enabledChanged) return null;
	const patch: PromptPresetBlockPatch = { occurrenceId: slot.id, type: "role", role: draft.role };
	if (enabledChanged) patch.enabled = draft.enabled;
	return patch;
}

export const draftIsDirty = (slot: ResolvedPromptPresetSlot, draft: BlockDraft): boolean =>
	draftToPatch(slot, draft) !== null;

export interface DirtyBlockPatches {
	patches: PromptPresetBlockPatch[];
	submitted: Record<number, BlockDraft>;
}

// @approved
//  Save-on-leave submits every dirty occurrence in one typed domain command.
// The patches address occurrences, and the submitted map carries the exact
// versions that may be retired once a fresh recipe is accepted.
export function dirtyBlockPatches(
	preset: ConversationPromptPreset,
	drafts: Record<number, BlockDraft>,
): DirtyBlockPatches {
	const patches: PromptPresetBlockPatch[] = [];
	const submitted: Record<number, BlockDraft> = {};
	for (const slot of preset.slots) {
		const draft = drafts[slot.id];
		if (draft === undefined) continue;
		const patch = draftToPatch(slot, draft);
		if (patch === null) continue;
		patches.push(patch);
		submitted[slot.id] = draft;
	}
	return { patches, submitted };
}
