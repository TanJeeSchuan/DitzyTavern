import type { PromptPresetSummary } from "../../shared/contract/prompt-preset";

export class PromptPresetNotFoundError extends Error {
	readonly presetId: number;

	constructor(presetId: number) {
		super(`Prompt Preset ${presetId} was not found.`);
		this.name = "PromptPresetNotFoundError";
		this.presetId = presetId;
	}
}

// @approved
//  Typed revision conflict. Carries the authoritative current preset
// so callers can recover without overwriting their local draft.
export class StalePromptPresetRevisionError extends Error {
	readonly presetId: number;
	readonly expectedRevision: number;
	readonly actualRevision: number;
	readonly currentPreset: PromptPresetSummary;

	constructor(
		presetId: number,
		expectedRevision: number,
		actualRevision: number,
		currentPreset: PromptPresetSummary,
	) {
		super(
			`Expected Prompt Preset ${presetId} revision ${expectedRevision}, but the current revision is ${actualRevision}.`,
		);
		this.name = "StalePromptPresetRevisionError";
		this.presetId = presetId;
		this.expectedRevision = expectedRevision;
		this.actualRevision = actualRevision;
		this.currentPreset = currentPreset;
	}
}

export class InvalidPromptPresetCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidPromptPresetCommandError";
	}
}

// @approved
//  Typed deletion-impact conflict. The affected-Conversation count changed
// since the author confirmed deletion even though the preset's metadata
// revision did not; carries the authoritative current preset so the
// confirmation can be renewed with the exact impact.
export class PromptPresetDeletionImpactChangedError extends Error {
	readonly currentPreset: PromptPresetSummary;

	constructor(expectedConversationCount: number, currentPreset: PromptPresetSummary) {
		super(
			`Expected Prompt Preset ${currentPreset.id} to affect ${expectedConversationCount} Conversations, but it currently affects ${currentPreset.conversationCount}.`,
		);
		this.name = "PromptPresetDeletionImpactChangedError";
		this.currentPreset = currentPreset;
	}
}

// @approved
//  The Default preset stays available as the nondeletable destination
// of new Conversations and preset deletions, so removing it is refused no
// matter which revision the caller saw.
export class DefaultPromptPresetNotRemovableError extends Error {
	constructor() {
		super("The Default Prompt Preset cannot be deleted.");
		this.name = "DefaultPromptPresetNotRemovableError";
	}
}
