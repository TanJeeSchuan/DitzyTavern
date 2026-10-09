import { Value } from "@sinclair/typebox/value";
import { api } from "./lib/eden";
import type { EdenResponse } from "./lib/eden";
import { invalidOutcome, readOutcomeErrors } from "../shared/contract/outcomes";
import { requestData, requestOutcome } from "./lib/request-outcome";
import {
	nativePromptPreset,
	promptPresetCommandApplied,
	promptPresetCommandErrors,
	promptPresetListResponse,
	promptPresetRecipeApplied,
	sillyTavernImportApplied,
	sillyTavernImportPreview,
} from "../shared/contract/prompt-preset";
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
	PromptPresetDeletionResult,
	PromptPresetSummary,
} from "../shared/contract/prompt-preset";

// @approved
//  Typed client for the Prompt Preset library transport adapters. Outcomes
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

export async function applyPromptPresetCommand(
	command: PromptPresetCommand,
) {
	return requestOutcome(
		api.api["prompt-presets"].commands.post(command),
		promptPresetCommandApplied,
		promptPresetCommandErrors,
	);
}

export async function listPromptPresets(): Promise<PromptPresetSummary[]> {
	return (await requestData(api.api["prompt-presets"].get(), promptPresetListResponse)).presets;
}

export async function loadNativePromptPreset(presetId: number): Promise<NativePromptPreset> {
	return requestData(api.api["prompt-presets"]({ presetId }).export.get(), nativePromptPreset);
}

export function parseNativePromptPreset(text: string): NativePromptPreset | null {
	try {
		return Value.Parse(nativePromptPreset, JSON.parse(text));
	} catch {
		return null;
	}
}

export async function importNativePromptPreset(
	native: NativePromptPreset,
) {
	return requestOutcome(
		api.api["prompt-presets"].import.post(native),
		promptPresetCommandApplied,
		invalidOutcome,
	);
}

export async function reviewSillyTavernPromptPreset(
	source: SillyTavernJsonValue,
	name?: string,
	orderListId?: string,
) {
	const request = sillyTavernImportRequest(source, name, orderListId);
	return requestOutcome(
		api.api["prompt-presets"].import.sillytavern.review.post(request),
		sillyTavernImportPreview,
		invalidOutcome,
	);
}

export async function commitSillyTavernPromptPreset(
	source: SillyTavernJsonValue,
	name?: string,
	orderListId?: string,
) {
	const request = sillyTavernImportRequest(source, name, orderListId);
	return requestOutcome(
		api.api["prompt-presets"].import.sillytavern.post(request),
		sillyTavernImportApplied,
		invalidOutcome,
	);
}

// @approved
// The applied-command response states its variant, so the popup narrows on
//  the outcome tag instead of inferring it from which fields are present.
export type PresetCommandOutcome = Awaited<ReturnType<typeof applyPromptPresetCommand>>;

// @approved
//  The authoritative recipe operations the popup composes. Each call
// persists one smallest operation against the shared preset; the applied response is only an
// acknowledgment because the editor reloads the Conversation-resolved recipe through its read
// seam.
export type PromptPresetOperationOutcome = Awaited<ReturnType<typeof applyRecipeOperation>>;

// @approved
//  Every recipe operation responds with the same applied acknowledgment plus
// the shared not-found/invalid envelopes, so one adapter maps the treaty union for all of them.
type RecipeOperationRequest = EdenResponse<
	PromptPresetRecipeApplied,
	{ status: number; value: { outcome: "not-found" } | { outcome: "invalid"; reason: string } }
>;

const applyRecipeOperation = (request: RecipeOperationRequest) =>
	requestOutcome(request, promptPresetRecipeApplied, readOutcomeErrors);

export function addPromptPresetReference(
	presetId: number,
	reference: PromptBlockReference,
): Promise<PromptPresetOperationOutcome> {
	return applyRecipeOperation(
		api.api["prompt-presets"]({ presetId }).blocks.post({ reference })
	);
}

// @approved
//  Appends one blank authored instruction occurrence; its name, text, and
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

// @approved
//  The footer and save-on-leave submit occurrence-addressed block
// drafts through the recipe route, which is never revision-guarded.
// Block saves never travel the library command executor, which accepts
// only revision-guarded commands.
export function savePromptPresetBlockPatches(
	presetId: number,
	patches: readonly PromptPresetBlockPatch[],
): Promise<PromptPresetOperationOutcome> {
	return applyRecipeOperation(
		api.api["prompt-presets"]({ presetId }).blocks.patches.post({ patches: [...patches] }),
	);
}
