import type { PromptPresetSummary } from "../../shared/contract/prompt-preset";

export class PromptPresetNotFoundError extends Error {
	readonly presetId: number;

	constructor(presetId: number) {
		super(`Prompt Preset ${presetId} was not found.`);
		this.name = "PromptPresetNotFoundError";
		this.presetId = presetId;
	}
}

// ==[HUMAN APPROVED]== Typed revision conflict. Carries the authoritative current preset
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

// ==[HUMAN APPROVED]== The Default preset stays available as the nondeletable destination
// of new Conversations and preset deletions, so removing it is refused no
// matter which revision the caller saw.
export class DefaultPromptPresetNotRemovableError extends Error {
	constructor() {
		super("The Default Prompt Preset cannot be deleted.");
		this.name = "DefaultPromptPresetNotRemovableError";
	}
}
