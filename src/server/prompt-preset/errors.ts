import type { PromptPresetSummary } from "../../shared/contract/prompt-preset";

export class PromptPresetNotFoundError extends Error {
	readonly outcome = "not-found" as const;

	readonly presetId: number;

	constructor(presetId: number) {
		super(`Prompt Preset ${presetId} was not found.`);
		this.name = "PromptPresetNotFoundError";
		this.presetId = presetId;
	}
}

export class InvalidPromptPresetCommandError extends Error {
	readonly outcome = "invalid" as const;
	readonly details = { reason: this.message };

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
	readonly outcome = "conflict" as const;
	readonly details;

	constructor(expectedConversationCount: number, current: PromptPresetSummary) {
		super(
			`Expected Prompt Preset ${current.id} to affect ${expectedConversationCount} Conversations, but it currently affects ${current.conversationCount}.`,
		);
		this.name = "PromptPresetDeletionImpactChangedError";
		this.details = { reason: "deletion-impact" as const, current };
	}
}

// @approved
//  Built-in presets stay available as the nondeletable destination
// of new Conversations and preset deletions, so removing it is refused no
// matter which revision the caller saw.
export class BuiltInPromptPresetNotRemovableError extends Error {
	readonly outcome = "not-removable" as const;
	readonly details = { reason: this.message };

	constructor() {
		super("Built-in Prompt Presets cannot be deleted.");
		this.name = "BuiltInPromptPresetNotRemovableError";
	}
}
