import type { TSchema } from "@sinclair/typebox";
import { presentDomainError } from "./domain-error";
import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import {
	addPromptPresetBlock,
	addPromptPresetInstruction,
	duplicatePromptPresetBlock,
	executePromptPresetCommand,
	importNativePromptPreset,
	importSillyTavernPromptPreset,
	isSillyTavernJsonValue,
	listPromptPresets,
	movePromptPresetBlock,
	readNativePromptPreset,
	removePromptPresetBlock,
	reviewSillyTavernPromptPreset,
	savePromptPresetBlockPatches,
	setPromptPresetBlockEnabled,
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

const recipeResponseSchema = {
	200: promptPresetRecipeApplied,
	404: notFoundOutcome,
	422: invalidOutcome,
};
const commandErrors = { 404: notFoundOutcome, 409: promptPresetCommandConflict, 422: invalidOutcome };

const respond = <T, R, S extends Partial<Record<404 | 409 | 410 | 422, TSchema>>>(
	operation: () => T,
	errors: S,
	applied: (value: T) => R,
) => {
	try { return applied(operation()); }
	catch (error) { return presentDomainError(error, errors); }
};

const recipeResponse = <T>(operation: () => T) =>
	respond(operation, recipeResponseSchema, () => ({ outcome: "applied" as const }));
const importResponse = <T, R>(operation: () => T, applied: (value: T) => R) =>
	respond(operation, { 422: invalidOutcome }, applied);
const commandResponse = <T, R>(operation: () => T, applied: (value: T) => R) =>
	respond(operation, commandErrors, applied);

export const createPromptPresetRoutes = (database: Database) =>
	new Elysia()
		.post(
			"/api/prompt-presets/import/sillytavern/review",
			({ body }) => {
				if (!isSillyTavernJsonValue(body)) {
					return invalidResponse("SillyTavern JSON must be valid JSON.");
				}
				return importResponse(
					() => reviewSillyTavernPromptPreset(body),
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
					() =>
						importSillyTavernPromptPreset(database, body),
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
					() =>
						importNativePromptPreset(database, body),
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
					() =>
						executePromptPresetCommand(database, body),
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
				recipeResponse(() =>
						savePromptPresetBlockPatches(database, params.presetId, body.patches)),
			{
				params: presetIdParams,
				body: promptPresetBlockPatchesBody,
				response: recipeResponseSchema,
			},
		)
		.post(
			"/api/prompt-presets/:presetId/blocks",
			({ params, body }) =>
				recipeResponse(() =>
						addPromptPresetBlock(database, params.presetId, body.reference)),
			{
				params: presetIdParams,
				body: addPromptPresetBlockBody,
				response: recipeResponseSchema,
			},
		)
		.post(
			"/api/prompt-presets/:presetId/blocks/:blockId/move",
			({ params, body }) =>
				recipeResponse(() =>
						movePromptPresetBlock(
							database,
							params.presetId,
							params.blockId,
							body.toPosition,
						)),
			{
				params: blockIdParams,
				body: movePromptPresetBlockBody,
				response: recipeResponseSchema,
			},
		)
		.post(
			"/api/prompt-presets/:presetId/blocks/:blockId/toggle",
			({ params, body }) =>
				recipeResponse(() =>
						setPromptPresetBlockEnabled(
							database,
							params.presetId,
							params.blockId,
							body.enabled,
						)),
			{
				params: blockIdParams,
				body: setPromptPresetBlockEnabledBody,
				response: recipeResponseSchema,
			},
		)
		.post(
			"/api/prompt-presets/:presetId/blocks/:blockId/duplicate",
			({ params }) =>
				recipeResponse(() =>
						duplicatePromptPresetBlock(database, params.presetId, params.blockId)),
			{
				params: blockIdParams,
				response: recipeResponseSchema,
			},
		)
		.delete(
			"/api/prompt-presets/:presetId/blocks/:blockId",
			({ params }) =>
				recipeResponse(() =>
						removePromptPresetBlock(database, params.presetId, params.blockId)),
			{
				params: blockIdParams,
				response: recipeResponseSchema,
			},
		)
		.post(
			"/api/prompt-presets/:presetId/instructions",
			({ params }) =>
				recipeResponse(() =>
						addPromptPresetInstruction(database, params.presetId)),
			{
				params: presetIdParams,
				response: recipeResponseSchema,
			},
		);
