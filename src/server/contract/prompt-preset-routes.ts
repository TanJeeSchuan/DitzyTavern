import type { Database } from "bun:sqlite";
import { Elysia, status } from "elysia";
import {
	addPromptPresetBlock,
	addPromptPresetInstruction,
	DefaultPromptPresetNotRemovableError,
	duplicatePromptPresetBlock,
	executePromptPresetCommand,
	importNativePromptPreset,
	importSillyTavernPromptPreset,
	InvalidPromptPresetCommandError,
	InvalidPromptPresetOperationError,
	isSillyTavernJsonValue,
	listPromptPresets,
	movePromptPresetBlock,
	PromptPresetBlockNotFoundError,
	PromptPresetDeletionImpactChangedError,
	PromptPresetNotFoundError,
	readNativePromptPreset,
	removePromptPresetBlock,
	reviewSillyTavernPromptPreset,
	savePromptPresetBlockPatches,
	setPromptPresetBlockEnabled,
	StalePromptPresetRevisionError,
} from "../prompt-preset";

import { invalidOutcome, notFoundOutcome } from "../../shared/contract/outcomes";
import { invalidResponse, notFoundResponse } from "./responses";
import {
	addPromptPresetBlockBody,
	blockIdParams,
	movePromptPresetBlockBody,
	nativePromptPreset,
	presetIdParams,
	promptPresetBlockPatchesBody,
	promptPresetCommandApplied,
	promptPresetCommandBody,
	promptPresetCommandConflict,
	promptPresetListResponse,
	promptPresetRecipeApplied,
	setPromptPresetBlockEnabledBody,
	sillyTavernImportApplied,
	sillyTavernImportPreview,
	sillyTavernImportRequest,
} from "../../shared/contract/prompt-preset";
import type { PromptPresetConflict } from "../../shared/contract/prompt-preset";

// @approved
//  Thin typed adapter over the Prompt Preset library and recipe seams. The
// database is injected so tests can mount the same routes against a temporary
// store; production passes undefined to use the default connection per
// request. One classifier maps every domain failure to its wire envelope, so
// no route re-states which error classes it recognizes.

type PresetFailure =
	| { outcome: "not-found" }
	| { outcome: "invalid"; reason: string }
	| { outcome: "conflict"; conflict: PromptPresetConflict }
	| { outcome: "not-removable"; reason: string };

type RecipeOutcome<T> =
	| { outcome: "ok"; value: T }
	| Extract<PresetFailure, { outcome: "not-found" } | { outcome: "invalid" }>;
type ImportOutcome<T> =
	| { outcome: "ok"; value: T }
	| Extract<PresetFailure, { outcome: "invalid" }>;
type CommandOutcome<T> = { outcome: "ok"; value: T } | PresetFailure;

const classifyPresetFailure = (error: Error): PresetFailure | null => {
	if (
		error instanceof PromptPresetNotFoundError ||
		error instanceof PromptPresetBlockNotFoundError
	) {
		return { outcome: "not-found" };
	}
	if (error instanceof InvalidPromptPresetCommandError) {
		return { outcome: "invalid", reason: error.message };
	}
	if (error instanceof InvalidPromptPresetOperationError) {
		return { outcome: "invalid", reason: error.reason };
	}
	if (error instanceof StalePromptPresetRevisionError) {
		return {
			outcome: "conflict",
			conflict: {
				outcome: "conflict",
				reason: "stale-revision",
				expectedRevision: error.expectedRevision,
				actualRevision: error.actualRevision,
				currentPreset: error.currentPreset,
			},
		};
	}
	if (error instanceof PromptPresetDeletionImpactChangedError) {
		return {
			outcome: "conflict",
			conflict: {
				outcome: "conflict",
				reason: "deletion-impact",
				currentPreset: error.currentPreset,
			},
		};
	}
	if (error instanceof DefaultPromptPresetNotRemovableError) {
		return { outcome: "not-removable", reason: error.message };
	}
	return null;
};

// @approved
//  A recipe operation can fail only as missing or invalid, so a library
// conflict escapes as the invariant violation it is.
const runRecipeOperation = <T>(operation: () => T): RecipeOutcome<T> => {
	try {
		return { outcome: "ok", value: operation() };
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		const failure = classifyPresetFailure(error);
		if (failure?.outcome === "not-found" || failure?.outcome === "invalid") return failure;
		throw error;
	}
};

// @approved
//  Import and review report invalid input; their authoritative failures are
// the same typed invalid envelope the library commands use.
const runImportOperation = <T>(operation: () => T): ImportOutcome<T> => {
	try {
		return { outcome: "ok", value: operation() };
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		const failure = classifyPresetFailure(error);
		if (failure?.outcome === "invalid") return failure;
		throw error;
	}
};

const runPresetCommand = <T>(operation: () => T): CommandOutcome<T> => {
	try {
		return { outcome: "ok", value: operation() };
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		const failure = classifyPresetFailure(error);
		if (failure === null) throw error;
		return failure;
	}
};

const recipeResponse = <T>(outcome: RecipeOutcome<T>) =>
	outcome.outcome === "ok"
		? { outcome: "applied" as const }
		: outcome.outcome === "not-found"
			? notFoundResponse()
			: invalidResponse(outcome.reason);

const importResponse = <T, R>(outcome: ImportOutcome<T>, applied: (value: T) => R) =>
	outcome.outcome === "ok" ? applied(outcome.value) : invalidResponse(outcome.reason);

const commandResponse = <T, R>(outcome: CommandOutcome<T>, applied: (value: T) => R) =>
	outcome.outcome === "ok"
		? applied(outcome.value)
		: outcome.outcome === "not-found"
			? notFoundResponse()
			: outcome.outcome === "invalid"
				? invalidResponse(outcome.reason)
				: outcome.outcome === "conflict"
					? status(409, outcome.conflict)
					: status(409, { outcome: "not-removable" as const, reason: outcome.reason });

const recipeResponseSchema = {
	200: promptPresetRecipeApplied,
	404: notFoundOutcome,
	422: invalidOutcome,
};

export const createPromptPresetRoutes = (database: Database) =>
	new Elysia()
		.post(
			"/api/prompt-presets/import/sillytavern/review",
			({ body }) => {
				if (!isSillyTavernJsonValue(body)) {
					return invalidResponse("SillyTavern JSON must be valid JSON.");
				}
				return importResponse(
					runImportOperation(() => reviewSillyTavernPromptPreset(body)),
					(preview) => preview,
				);
			},
			{
				body: sillyTavernImportRequest,
				response: { 200: sillyTavernImportPreview, 422: invalidOutcome },
			},
		)
		.post(
			"/api/prompt-presets/import/sillytavern",
			({ body }) => {
				if (!isSillyTavernJsonValue(body)) {
					return invalidResponse("SillyTavern JSON must be valid JSON.");
				}
				return importResponse(
					runImportOperation(() =>
						importSillyTavernPromptPreset(database, body)),
					(imported) => imported,
				);
			},
			{
				body: sillyTavernImportRequest,
				response: { 200: sillyTavernImportApplied, 422: invalidOutcome },
			},
		)
		.get(
			"/api/prompt-presets/:presetId/export",
			({ params }) => {
				const exported = readNativePromptPreset(database, params.presetId);
				return exported === undefined ? notFoundResponse() : exported;
			},
			{
				params: presetIdParams,
				response: { 200: nativePromptPreset, 404: notFoundOutcome },
			},
		)
		.post(
			"/api/prompt-presets/import",
			({ body }) =>
				importResponse(
					runImportOperation(() =>
						importNativePromptPreset(database, body)),
					(preset) => ({ outcome: "applied" as const, preset }),
				),
			{
				body: nativePromptPreset,
				response: { 200: promptPresetCommandApplied, 422: invalidOutcome },
			},
		)
		.get(
			"/api/prompt-presets",
			() => ({
				presets: listPromptPresets(database),
			}),
			{ response: promptPresetListResponse },
		)
		.post(
			"/api/prompt-presets/commands",
			({ body }) =>
				commandResponse(
					// @approved
					//  SAFETY: Elysia validates the discriminated command shape at this
					// boundary; the library then guards the revision and derives the
					// deletion impact from the selections present in the transaction.
					runPresetCommand(() =>
						executePromptPresetCommand(database, body)),
					(outcome) => outcome.kind === "deleted"
						? { outcome: "deleted" as const, result: outcome.result }
						: { outcome: "applied" as const, preset: outcome.preset },
				),
			{
				body: promptPresetCommandBody,
				response: {
					200: promptPresetCommandApplied,
					409: promptPresetCommandConflict,
					404: notFoundOutcome,
					422: invalidOutcome,
				},
			},
		)
		.post(
			"/api/prompt-presets/:presetId/blocks/patches",
			({ params, body }) =>
				recipeResponse(runRecipeOperation(() =>
						savePromptPresetBlockPatches(database, params.presetId, body.patches))),
			{
				params: presetIdParams,
				body: promptPresetBlockPatchesBody,
				response: recipeResponseSchema,
			},
		)
		.post(
			"/api/prompt-presets/:presetId/blocks",
			({ params, body }) =>
				recipeResponse(runRecipeOperation(() =>
						addPromptPresetBlock(database, params.presetId, body.reference))),
			{
				params: presetIdParams,
				body: addPromptPresetBlockBody,
				response: recipeResponseSchema,
			},
		)
		.post(
			"/api/prompt-presets/:presetId/blocks/:blockId/move",
			({ params, body }) =>
				recipeResponse(runRecipeOperation(() =>
						movePromptPresetBlock(
							database,
							params.presetId,
							params.blockId,
							body.toPosition,
						))),
			{
				params: blockIdParams,
				body: movePromptPresetBlockBody,
				response: recipeResponseSchema,
			},
		)
		.post(
			"/api/prompt-presets/:presetId/blocks/:blockId/toggle",
			({ params, body }) =>
				recipeResponse(runRecipeOperation(() =>
						setPromptPresetBlockEnabled(
							database,
							params.presetId,
							params.blockId,
							body.enabled,
						))),
			{
				params: blockIdParams,
				body: setPromptPresetBlockEnabledBody,
				response: recipeResponseSchema,
			},
		)
		.post(
			"/api/prompt-presets/:presetId/blocks/:blockId/duplicate",
			({ params }) =>
				recipeResponse(runRecipeOperation(() =>
						duplicatePromptPresetBlock(database, params.presetId, params.blockId))),
			{
				params: blockIdParams,
				response: recipeResponseSchema,
			},
		)
		.delete(
			"/api/prompt-presets/:presetId/blocks/:blockId",
			({ params }) =>
				recipeResponse(runRecipeOperation(() =>
						removePromptPresetBlock(database, params.presetId, params.blockId))),
			{
				params: blockIdParams,
				response: recipeResponseSchema,
			},
		)
		.post(
			"/api/prompt-presets/:presetId/instructions",
			({ params }) =>
				recipeResponse(runRecipeOperation(() =>
						addPromptPresetInstruction(database, params.presetId))),
			{
				params: presetIdParams,
				response: recipeResponseSchema,
			},
		);
