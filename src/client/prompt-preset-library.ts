import { Value } from "@sinclair/typebox/value";
import { api } from "./lib/eden";
import { commandOutcome } from "./lib/command-outcome";
import { nativePromptPreset } from "../shared/contract/prompt-preset";
import type {
	NativePromptPreset,
	SillyTavernImportApplied,
	SillyTavernImportPreview,
	SillyTavernImportRequest,
	SillyTavernJsonValue,
	PromptPresetCommand,
	PromptPresetConflict,
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
	NativePromptPreset,
	SillyTavernImportPreview,
	SillyTavernImportApplied,
	SillyTavernImportRequest,
	SillyTavernJsonValue,
	PromptPresetSummary,
};

const sillyTavernImportRequest = (
	source: SillyTavernJsonValue,
	name?: string,
	orderListId?: string,
): SillyTavernImportRequest => {
	const request: SillyTavernImportRequest = { source };
	if (name !== undefined) request.name = name;
	if (orderListId !== undefined) request.orderListId = orderListId;
	return request;
};

type PromptPresetImportErrorPayload = { outcome?: string; reason?: string };

const promptPresetImportError = (
	payload: PromptPresetImportErrorPayload | null,
): { status: "invalid"; reason: string } | { status: "network" } =>
	payload?.outcome === "invalid" && payload.reason !== undefined
		? { status: "invalid", reason: payload.reason }
		: { status: "network" };

export type PresetCommandOutcome =
	| { status: "applied"; preset: PromptPresetSummary }
	// ==[HUMAN APPROVED]== A confirmed deletion returns the derived reassignment instead of
	// a summary: the preset no longer exists after the authoritative command.
	| { status: "deleted"; result: PromptPresetDeletionResult }
	| { status: "conflict"; conflict: PromptPresetConflict }
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

export async function loadNativePromptPreset(presetId: number): Promise<NativePromptPreset> {
	const { data, error } = await api.api["prompt-presets"]({ presetId }).export.get();
	if (error || !data) {
		throw new Error("Unable to export the Prompt Preset.");
	}
	return data;
}

export function parseNativePromptPreset(text: string): NativePromptPreset | null {
	try {
		return Value.Parse(nativePromptPreset, JSON.parse(text));
	} catch {
		return null;
	}
}

export type PromptPresetImportOutcome =
	| { status: "applied"; preset: PromptPresetSummary }
	| { status: "invalid"; reason: string }
	| { status: "network" };

export async function importNativePromptPreset(
	native: NativePromptPreset,
): Promise<PromptPresetImportOutcome> {
	try {
		const { data, error } = await api.api["prompt-presets"].import.post(native);
		if (error) {
			// ==[HUMAN APPROVED]== SAFETY: Eden exposes the route's typed error envelope as an unknown value;
			// only an invalid outcome with a string reason is rendered as import feedback.
			const value = error.value as PromptPresetImportErrorPayload | null;
			return promptPresetImportError(value);
		}
		return "preset" in data
			? { status: "applied", preset: data.preset }
			: { status: "network" };
	} catch {
		return { status: "network" };
	}
}

export type SillyTavernImportOutcome =
	| { status: "review"; preview: SillyTavernImportPreview }
	| { status: "invalid"; reason: string }
	| { status: "network" };

export async function reviewSillyTavernPromptPreset(
	source: SillyTavernJsonValue,
	name?: string,
	orderListId?: string,
): Promise<SillyTavernImportOutcome> {
	try {
		const request = sillyTavernImportRequest(source, name, orderListId);
		const { data, error } = await api.api["prompt-presets"].import.sillytavern.review.post(request);
		if (error) {
			return promptPresetImportError(error.value);
		}
		return { status: "review", preview: data };
	} catch {
		return { status: "network" };
	}
}

export async function commitSillyTavernPromptPreset(
	source: SillyTavernJsonValue,
	name?: string,
	orderListId?: string,
): Promise<{ status: "applied"; preview: SillyTavernImportApplied } | { status: "invalid"; reason: string } | { status: "network" }> {
	try {
		const request = sillyTavernImportRequest(source, name, orderListId);
		const { data, error } = await api.api["prompt-presets"].import.sillytavern.post(request);
		if (error) {
			return promptPresetImportError(error.value);
		}
		return { status: "applied", preview: data };
	} catch {
		return { status: "network" };
	}
}

export async function applyPromptPresetCommand(
	command: PromptPresetCommand,
): Promise<PresetCommandOutcome> {
	const { data, error } = await api.api["prompt-presets"].commands.post(command);
	if (error) {
		return commandOutcome(error.value, {
			conflict: (payload) => ({ status: "conflict", conflict: payload }),
			"not-removable": (payload) => ({ status: "not-removable", reason: payload.reason }),
			invalid: (payload) => ({ status: "invalid", reason: payload.reason }),
		});
	}
	// ==[HUMAN APPROVED]== The applied-command response states its variant, so the adapter
	// narrows on the outcome tag instead of inferring it from which fields are present.
	return data.outcome === "deleted"
		? { status: "deleted", result: data.result }
		: { status: "applied", preset: data.preset };
}
