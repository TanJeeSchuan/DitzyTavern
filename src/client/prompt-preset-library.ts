import { api } from "./lib/eden";
import { commandOutcome } from "./lib/command-outcome";
import type {
	PromptPresetCommand,
	PromptPresetDeletionResult,
	PromptPresetSummary,
} from "../shared/contract/prompt-preset";

// ==[HUMAN APPROVED]== Typed client for the Prompt Preset library transport adapters. Outcomes
// mirror the server's typed results so the popup can recover from conflicts
// without losing its list. Every shape is the canonical shared wire schema's
// Static type, so the client can never drift from the server.

export type {
	PromptPresetCommand,
	PromptPresetDeletionResult,
	PromptPresetSummary,
};

export type PresetCommandOutcome =
	| { status: "applied"; preset: PromptPresetSummary }
	// ==[HUMAN APPROVED]== A confirmed deletion returns the derived reassignment instead of
	// a summary: the preset no longer exists after the authoritative command.
	| { status: "deleted"; result: PromptPresetDeletionResult }
	| { status: "conflict"; currentPreset: PromptPresetSummary }
	// ==[HUMAN APPROVED]== The Default preset cannot be deleted; the reason states that
	// policy.
	| { status: "not-removable"; reason: string }
	| { status: "not-found" }
	| { status: "invalid"; reason: string }
	| { status: "network" };

export async function listPromptPresets(): Promise<PromptPresetSummary[]> {
	const { data, error } = await api.api["prompt-presets"].get();
	if (error || !data) {
		throw new Error("Unable to list Prompt Presets");
	}
	return data.presets;
}

export async function applyPromptPresetCommand(
	command: PromptPresetCommand,
): Promise<PresetCommandOutcome> {
	const { data, error } = await api.api["prompt-presets"].commands.post(command);
	if (error) {
		return commandOutcome(error.value, {
			conflict: (payload) => ({ status: "conflict", currentPreset: payload.currentPreset }),
			"not-removable": (payload) => ({ status: "not-removable", reason: payload.reason }),
			invalid: (payload) => ({ status: "invalid", reason: payload.reason }),
		});
	}
	// ==[HUMAN APPROVED]== Deletion returns the typed reassignment result instead of a
	// summary; every other command returns the authoritative updated preset.
	// The payload is a union discriminated by the result-only `result` field.
	if ("result" in data) {
		return { status: "deleted", result: data.result };
	}
	return { status: "applied", preset: data.preset };
}
