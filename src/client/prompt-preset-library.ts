import { Value } from "@sinclair/typebox/value";
import { api } from "./lib/eden";
import { requestData } from "./lib/request-outcome";
import { requestOutcome } from "./lib/request-route-outcome";
import {
	nativePromptPreset,
	promptPresetCommandResponse,
	promptPresetExportResponse,
	promptPresetImportResponse,
	promptPresetListResponse,
	promptPresetRecipeResponse,
	sillyTavernPresetImportResponse,
	sillyTavernPresetReviewResponse,
} from "../shared/contract/prompt-preset";
import type {
	NativePromptPreset,
	PromptBlockReference,
	PromptPresetBlockPatch,
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
	return requestOutcome(api.api["prompt-presets"].commands.post(command), promptPresetCommandResponse);
}

export async function listPromptPresets(signal?: AbortSignal): Promise<PromptPresetSummary[]> {
	return (await requestData(api.api["prompt-presets"].get({ fetch: { signal } }), promptPresetListResponse[200])).presets;
}

export async function loadNativePromptPreset(presetId: number): Promise<NativePromptPreset> {
	return requestData(api.api["prompt-presets"]({ presetId }).export.get(), promptPresetExportResponse[200]);
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
	return requestOutcome(api.api["prompt-presets"].import.post(native), promptPresetImportResponse);
}

export async function reviewSillyTavernPromptPreset(
	source: SillyTavernJsonValue,
	name?: string,
	orderListId?: string,
) {
	const request = sillyTavernImportRequest(source, name, orderListId);
	return requestOutcome(
		api.api["prompt-presets"].import.sillytavern.review.post(request),
		sillyTavernPresetReviewResponse,
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
		sillyTavernPresetImportResponse,
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
export type PromptPresetOperationOutcome = Awaited<ReturnType<typeof addPromptPresetReference>>;

export function addPromptPresetReference(
	presetId: number,
	reference: PromptBlockReference,
) {
	return requestOutcome(
		api.api["prompt-presets"]({ presetId }).blocks.post({ reference }),
		promptPresetRecipeResponse,
	);
}

// @approved
//  Appends one blank authored instruction occurrence; its name, text, and
// role are authored through the block editor's Save boundary.
export function addPromptPresetInstruction(
	presetId: number,
): Promise<PromptPresetOperationOutcome> {
	return requestOutcome(
		api.api["prompt-presets"]({ presetId }).instructions.post(),
		promptPresetRecipeResponse,
	);
}

export function movePromptPresetBlock(
	presetId: number,
	blockId: number,
	toPosition: number,
): Promise<PromptPresetOperationOutcome> {
	return requestOutcome(
		api.api["prompt-presets"]({ presetId }).blocks({ blockId }).move.post({ toPosition }),
		promptPresetRecipeResponse,
	);
}

export function setPromptPresetBlockEnabled(
	presetId: number,
	blockId: number,
	enabled: boolean,
): Promise<PromptPresetOperationOutcome> {
	return requestOutcome(
		api.api["prompt-presets"]({ presetId }).blocks({ blockId }).toggle.post({ enabled }),
		promptPresetRecipeResponse,
	);
}

export function duplicatePromptPresetBlock(
	presetId: number,
	blockId: number,
): Promise<PromptPresetOperationOutcome> {
	return requestOutcome(
		api.api["prompt-presets"]({ presetId }).blocks({ blockId }).duplicate.post(),
		promptPresetRecipeResponse,
	);
}

export function removePromptPresetBlock(
	presetId: number,
	blockId: number,
): Promise<PromptPresetOperationOutcome> {
	return requestOutcome(
		api.api["prompt-presets"]({ presetId }).blocks({ blockId }).delete(),
		promptPresetRecipeResponse,
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
	return requestOutcome(
		api.api["prompt-presets"]({ presetId }).blocks.patches.post({ patches: [...patches] }),
		promptPresetRecipeResponse,
	);
}
