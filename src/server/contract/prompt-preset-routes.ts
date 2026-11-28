import { presentDomainError } from "./domain-error";
import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { loadChatVersions } from "../box/registry";
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

import { invalidResponse, notFoundResponse } from "./responses";
import {
	addPromptPresetBlockBody,
	blockIdParams,
	movePromptPresetBlockBody,
	nativePromptPreset,
	presetIdParams,
	promptPresetBlockPatchesBody,
	promptPresetCommandBody,
	promptPresetCommandResponse,
	promptPresetExportResponse,
	promptPresetImportResponse,
	promptPresetListResponse,
	promptPresetRecipeResponse,
	setPromptPresetBlockEnabledBody,
	sillyTavernImportRequest,
	sillyTavernPresetImportResponse,
	sillyTavernPresetReviewResponse,
} from "../../shared/contract/prompt-preset";

const recipeResponse = (operation: () => void) => {
	try {
		operation();
		return { outcome: "applied" as const };
	} catch (error) {
		return presentDomainError(error, promptPresetRecipeResponse);
	}
};

export const createPromptPresetRoutes = (database: Database) =>
	new Elysia({ tags: ["Prompt Presets"] })
		.post(
			"/api/prompt-presets/import/sillytavern/review",
			({ body }) => {
				if (!isSillyTavernJsonValue(body)) {
					return invalidResponse("SillyTavern JSON must be valid JSON.");
				}
				try {
					return reviewSillyTavernPromptPreset(body);
				} catch (error) {
					return presentDomainError(error, sillyTavernPresetReviewResponse);
				}
			},
			{
				body: sillyTavernImportRequest,
				response: sillyTavernPresetReviewResponse,
			},
		)
		.post(
			"/api/prompt-presets/import/sillytavern",
			({ body }) => {
				if (!isSillyTavernJsonValue(body)) {
					return invalidResponse("SillyTavern JSON must be valid JSON.");
				}
				try {
					return importSillyTavernPromptPreset(database, body);
				} catch (error) {
					return presentDomainError(error, sillyTavernPresetImportResponse);
				}
			},
			{
				body: sillyTavernImportRequest,
				response: sillyTavernPresetImportResponse,
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
				response: promptPresetExportResponse,
			},
		)
		.post(
			"/api/prompt-presets/import",
			({ body }) => {
				try {
					const preset = importNativePromptPreset(database, body);
					return { outcome: "applied" as const, preset };
				} catch (error) {
					return presentDomainError(error, promptPresetImportResponse);
				}
			},
			{
				body: nativePromptPreset,
				response: promptPresetImportResponse,
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
			({ body }) => {
				// @approved
				//  SAFETY: Elysia validates the discriminated command shape at this
				// boundary; the library then guards the revision and derives the
				// deletion impact from the selections present in the transaction.
				try {
					const outcome = executePromptPresetCommand(database, body);
					return outcome.kind === "deleted"
						? { outcome: "deleted" as const, result: outcome.result }
						: { outcome: "applied" as const, preset: outcome.preset };
				} catch (error) {
					return presentDomainError(error, promptPresetCommandResponse);
				}
			},
			{
				body: promptPresetCommandBody,
				response: promptPresetCommandResponse,
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
				response: promptPresetRecipeResponse,
			},
		)
		.post(
			"/api/prompt-presets/:presetId/blocks",
			async ({ params, body }) => {
				const { conversationId, reference } = body;
				if (conversationId !== undefined) {
					await loadChatVersions(database, conversationId).catch((error: Error) => {
						console.error(`[boxes] Chat ${conversationId}'s Box versions did not load:`, error);
					});
				}
				return recipeResponse(() => addPromptPresetBlock(database, params.presetId, reference, conversationId));
			},
			{
				params: presetIdParams,
				body: addPromptPresetBlockBody,
				response: promptPresetRecipeResponse,
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
				response: promptPresetRecipeResponse,
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
				response: promptPresetRecipeResponse,
			},
		)
		.post(
			"/api/prompt-presets/:presetId/blocks/:blockId/duplicate",
			({ params }) =>
				recipeResponse(() =>
						duplicatePromptPresetBlock(database, params.presetId, params.blockId)),
			{
				params: blockIdParams,
				response: promptPresetRecipeResponse,
			},
		)
		.delete(
			"/api/prompt-presets/:presetId/blocks/:blockId",
			({ params }) =>
				recipeResponse(() =>
						removePromptPresetBlock(database, params.presetId, params.blockId)),
			{
				params: blockIdParams,
				response: promptPresetRecipeResponse,
			},
		)
		.post(
			"/api/prompt-presets/:presetId/instructions",
			({ params }) =>
				recipeResponse(() =>
						addPromptPresetInstruction(database, params.presetId)),
			{
				params: presetIdParams,
				response: promptPresetRecipeResponse,
			},
		);
