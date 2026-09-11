import { Value } from "@sinclair/typebox/value";
import { api } from "./lib/eden";
import type { EdenResponse } from "./lib/eden";
import { commandOutcome } from "./lib/command-outcome";
import { nativePromptPreset } from "../shared/contract/prompt-preset";
import type {
	NativePromptPreset,
	PromptBlockReference,
	PromptPresetBlockPatch,
	PromptPresetRecipeApplied,
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
// Static type, so the client can never drift from the server. The global
// recipe operations live here with the library commands, because both address
// shared presets by identity.

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
		return data.outcome === "applied"
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

// ==[HUMAN APPROVED]== The authoritative recipe operations the popup composes. Each call
// persists one smallest operation against the shared preset; the applied response is only an
// acknowledgment because the editor reloads the Conversation-resolved recipe through its read
// seam.
export type PromptPresetOperationOutcome =
	| { status: "applied" }
	| { status: "invalid"; reason: string }
	| { status: "not-found" }
	| { status: "network" };

// ==[HUMAN APPROVED]== Every recipe operation responds with the same applied acknowledgment plus
// the shared not-found/invalid envelopes, so one adapter maps the treaty union for all of them.
// The shared command-outcome helper classifies an envelope the route never declares as
// unreachable, never as bad input.
type RecipeOperationError =
	| { outcome: "not-found" }
	| { outcome: "invalid"; reason: string };

const applyRecipeOperation = async (
	request: EdenResponse<PromptPresetRecipeApplied, { status: number; value: RecipeOperationError }>,
): Promise<PromptPresetOperationOutcome> => {
	try {
		const { data, error } = await request;
		if (error) {
			return commandOutcome(error.value, {
				invalid: (payload) => ({ status: "invalid", reason: payload.reason }),
			});
		}
		return data.outcome === "applied" ? { status: "applied" } : { status: "network" };
	} catch {
		return { status: "network" };
	}
};

export function addPromptPresetReference(
	presetId: number,
	reference: PromptBlockReference,
): Promise<PromptPresetOperationOutcome> {
	return applyRecipeOperation(
		api.api["prompt-presets"]({ presetId }).blocks.post({ reference })
	);
}

// ==[HUMAN APPROVED]== Appends one blank authored instruction occurrence; its name, text, and
// role are authored through the block editor's Save boundary.
export function addPromptPresetInstruction(
	presetId: number,
): Promise<PromptPresetOperationOutcome> {
	return applyRecipeOperation(
		api.api["prompt-presets"]({ presetId }).instructions.post()
	);
}

export function movePromptPresetBlock(
	presetId: number,
	blockId: number,
	toPosition: number,
): Promise<PromptPresetOperationOutcome> {
	return applyRecipeOperation(
		api.api["prompt-presets"]({ presetId }).blocks({ blockId }).move.post({ toPosition })
	);
}

export function setPromptPresetBlockEnabled(
	presetId: number,
	blockId: number,
	enabled: boolean,
): Promise<PromptPresetOperationOutcome> {
	return applyRecipeOperation(
		api.api["prompt-presets"]({ presetId }).blocks({ blockId }).toggle.post({ enabled })
	);
}

export function duplicatePromptPresetBlock(
	presetId: number,
	blockId: number,
): Promise<PromptPresetOperationOutcome> {
	return applyRecipeOperation(
		api.api["prompt-presets"]({ presetId }).blocks({ blockId }).duplicate.post()
	);
}

export function removePromptPresetBlock(
	presetId: number,
	blockId: number,
): Promise<PromptPresetOperationOutcome> {
	return applyRecipeOperation(
		api.api["prompt-presets"]({ presetId }).blocks({ blockId }).delete()
	);
}

// ==[HUMAN APPROVED]== The one authored-field save contract: an individual block Save submits
// exactly one occurrence-addressed patch, and save-on-leave submits the dirty
// set, both through the recipe route, which is never revision-guarded.
// Authored-field saves never travel the library command executor, which accepts
// only revision-guarded commands.
export function savePromptPresetBlockPatches(
	presetId: number,
	patches: readonly PromptPresetBlockPatch[],
): Promise<PromptPresetOperationOutcome> {
	return applyRecipeOperation(
		api.api["prompt-presets"]({ presetId }).blocks.patches.post({ patches: [...patches] }),
	);
}
