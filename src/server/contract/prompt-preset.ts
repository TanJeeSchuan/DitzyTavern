import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import {
	addPromptPresetBlock,
	addPromptPresetInstruction,
	duplicatePromptPresetBlock,
	InvalidPromptPresetOperationError,
	movePromptPresetBlock,
	PromptPresetBlockNotFoundError,
	removePromptPresetBlock,
	savePromptPresetBlockPatches,
	setPromptPresetBlockContent,
	setPromptPresetBlockEnabled,
	setPromptPresetBlockRole,
} from "../prompt-preset/blocks";
import { PromptPresetNotFoundError } from "../prompt-preset/errors";
import { withDatabase } from "../database/database";
import {
	addPromptPresetBlockBody,
	blockIdParams,
	movePromptPresetBlockBody,
	presetIdParams,
	promptPresetBlockPatchesBody,
	promptPresetRecipe,
	setPromptPresetBlockContentBody,
	setPromptPresetBlockEnabledBody,
	setPromptPresetBlockRoleBody,
} from "../../shared/contract/prompt-preset";
import { invalidResponse, notFoundResponse } from "./responses";
import { invalidOutcome, notFoundOutcome } from "../../shared/contract/outcomes";

// ==[HUMAN APPROVED]== Thin typed adapters over the Prompt Preset recipe operations. Every
// operation targets one stored occurrence of the shared preset, so saved
// changes reach every Conversation that selected the preset. The responses
// are the stored recipe as a fresh read.
type RecipeOperationOutcome<T> =
	| { outcome: "ok"; value: T }
	| { outcome: "not-found" }
	| { outcome: "invalid"; reason: string };

const runRecipeOperation = <T>(operation: () => T): RecipeOperationOutcome<T> => {
	try {
		return { outcome: "ok", value: operation() };
	} catch (error) {
		if (
			error instanceof PromptPresetNotFoundError ||
			error instanceof PromptPresetBlockNotFoundError
		) {
			return { outcome: "not-found" };
		}
		if (error instanceof InvalidPromptPresetOperationError) {
			return { outcome: "invalid", reason: error.reason };
		}
		throw error;
	}
};

const recipeOperationResponse = <T>(outcome: RecipeOperationOutcome<T>) =>
	outcome.outcome === "ok"
		? outcome.value
		: outcome.outcome === "not-found"
			? notFoundResponse()
			: invalidResponse(outcome.reason);

const withRecipeResponse = {
	200: promptPresetRecipe,
	404: notFoundOutcome,
	422: invalidOutcome,
};

export const createPromptPresetRecipeRoutes = (database: Database | undefined) =>
	new Elysia()
		.post(
			"/api/prompt-presets/:presetId/blocks/patches",
			({ params, body }) =>
				withDatabase(database, (connection) =>
					recipeOperationResponse(runRecipeOperation(() =>
						savePromptPresetBlockPatches(connection, params.presetId, body.patches))),
				),
			{
				params: presetIdParams,
				body: promptPresetBlockPatchesBody,
				response: withRecipeResponse,
			},
		)
		.post(
			"/api/prompt-presets/:presetId/blocks",
			({ params, body }) =>
				withDatabase(database, (connection) =>
					recipeOperationResponse(runRecipeOperation(() =>
						addPromptPresetBlock(connection, params.presetId, body.reference))),
				),
			{
				params: presetIdParams,
				body: addPromptPresetBlockBody,
				response: withRecipeResponse,
			},
		)
		.post(
			"/api/prompt-presets/:presetId/blocks/:blockId/move",
			({ params, body }) =>
				withDatabase(database, (connection) =>
					recipeOperationResponse(runRecipeOperation(() =>
						movePromptPresetBlock(
							connection,
							params.presetId,
							params.blockId,
							body.toPosition,
						))),
				),
			{
				params: blockIdParams,
				body: movePromptPresetBlockBody,
				response: withRecipeResponse,
			},
		)
		.post(
			"/api/prompt-presets/:presetId/blocks/:blockId/toggle",
			({ params, body }) =>
				withDatabase(database, (connection) =>
					recipeOperationResponse(runRecipeOperation(() =>
						setPromptPresetBlockEnabled(
							connection,
							params.presetId,
							params.blockId,
							body.enabled,
						))),
				),
			{
				params: blockIdParams,
				body: setPromptPresetBlockEnabledBody,
				response: withRecipeResponse,
			},
		)
		.post(
			"/api/prompt-presets/:presetId/blocks/:blockId/duplicate",
			({ params }) =>
				withDatabase(database, (connection) =>
					recipeOperationResponse(runRecipeOperation(() =>
						duplicatePromptPresetBlock(connection, params.presetId, params.blockId))),
				),
			{
				params: blockIdParams,
				response: withRecipeResponse,
			},
		)
		.delete(
			"/api/prompt-presets/:presetId/blocks/:blockId",
			({ params }) =>
				withDatabase(database, (connection) =>
					recipeOperationResponse(runRecipeOperation(() =>
						removePromptPresetBlock(connection, params.presetId, params.blockId))),
				),
			{
				params: blockIdParams,
				response: withRecipeResponse,
			},
		)
		.post(
			"/api/prompt-presets/:presetId/blocks/:blockId/role",
			({ params, body }) =>
				withDatabase(database, (connection) =>
					recipeOperationResponse(runRecipeOperation(() =>
						setPromptPresetBlockRole(
							connection,
							params.presetId,
							params.blockId,
							body.role,
						))),
				),
			{
				params: blockIdParams,
				body: setPromptPresetBlockRoleBody,
				response: withRecipeResponse,
			},
		)
		.post(
			"/api/prompt-presets/:presetId/instructions",
			({ params }) =>
				withDatabase(database, (connection) =>
					recipeOperationResponse(runRecipeOperation(() =>
						addPromptPresetInstruction(connection, params.presetId))),
				),
			{
				params: presetIdParams,
				response: withRecipeResponse,
			},
		)
		.post(
			"/api/prompt-presets/:presetId/blocks/:blockId/content",
			({ params, body }) =>
				withDatabase(database, (connection) =>
					recipeOperationResponse(runRecipeOperation(() =>
						setPromptPresetBlockContent(
							connection,
							params.presetId,
							params.blockId,
							body,
						))),
				),
			{
				params: blockIdParams,
				body: setPromptPresetBlockContentBody,
				response: withRecipeResponse,
			},
		);
