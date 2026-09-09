import type { Database } from "bun:sqlite";
import { Elysia, status } from "elysia";
import { withDatabase } from "../database/database";
import {
	DefaultPromptPresetNotRemovableError,
	executePromptPresetCommand,
	importSillyTavernPromptPreset,
	importNativePromptPreset,
	InvalidPromptPresetCommandError,
	InvalidPromptPresetOperationError,
	listPromptPresets,
	PromptPresetDeletionImpactChangedError,
	PromptPresetNotFoundError,
	readNativePromptPreset,
	reviewSillyTavernPromptPreset,
	isSillyTavernJsonValue,
	StalePromptPresetRevisionError,
} from "../prompt-preset";
import {
	notFoundOutcome,
	invalidOutcome,
} from "../../shared/contract/outcomes";
import { invalidResponse, notFoundResponse } from "./responses";
import {
	promptPresetCommandApplied,
	promptPresetCommandBody,
	promptPresetCommandConflict,
	promptPresetListResponse,
	sillyTavernImportPreview,
	sillyTavernImportApplied,
	sillyTavernImportRequest,
	nativePromptPreset,
	presetIdParams,
} from "../../shared/contract/prompt-preset";

// ==[HUMAN APPROVED]== Thin typed adapter over the Prompt Preset library seam. The database
// is injected so tests can mount the same routes against a temporary store;
// production passes undefined to use the default connection per request.
export const createPromptPresetLibraryRoutes = (database: Database | undefined) =>
	new Elysia()
		.post(
			"/api/prompt-presets/import/sillytavern/review",
			({ body }) => {
				try {
					if (!isSillyTavernJsonValue(body)) {
						return invalidResponse("SillyTavern JSON must be valid JSON.");
					}
					return reviewSillyTavernPromptPreset(body);
				} catch (error) {
					if (error instanceof InvalidPromptPresetCommandError) {
						return invalidResponse(error.message);
					}
					throw error;
				}
			},
			{
				body: sillyTavernImportRequest,
				response: { 200: sillyTavernImportPreview, 422: invalidOutcome },
			},
		)
		.post(
			"/api/prompt-presets/import/sillytavern",
			({ body }) => {
				try {
					if (!isSillyTavernJsonValue(body)) {
						return invalidResponse("SillyTavern JSON must be valid JSON.");
					}
					const imported = withDatabase(database, (connection) =>
						importSillyTavernPromptPreset(connection, body),
					);
					return imported;
				} catch (error) {
					if (error instanceof InvalidPromptPresetCommandError) {
						return invalidResponse(error.message);
					}
					throw error;
				}
			},
			{
				body: sillyTavernImportRequest,
				response: { 200: sillyTavernImportApplied, 422: invalidOutcome },
			},
		)
		.get(
			"/api/prompt-presets/:presetId/export",
			({ params }) => {
				const exported = withDatabase(database, (connection) =>
					readNativePromptPreset(connection, params.presetId),
				);
				return exported === undefined
					? notFoundResponse()
					: exported;
			},
			{
				params: presetIdParams,
				response: { 200: nativePromptPreset, 404: notFoundOutcome },
			},
		)
		.post(
			"/api/prompt-presets/import",
			({ body }) => {
				try {
					const preset = withDatabase(database, (connection) =>
						importNativePromptPreset(connection, body),
					);
					return { outcome: "applied" as const, preset };
				} catch (error) {
					if (error instanceof InvalidPromptPresetCommandError) {
						return invalidResponse(error.message);
					}
					throw error;
				}
			},
			{
				body: nativePromptPreset,
				response: { 200: promptPresetCommandApplied, 422: invalidOutcome },
			},
		)
		.get(
			"/api/prompt-presets",
			() => ({
				presets: withDatabase(database, (connection) => listPromptPresets(connection)),
			}),
			{ response: promptPresetListResponse },
		)
		.post(
			"/api/prompt-presets/commands",
			({ body }) => {
				try {
					// ==[HUMAN APPROVED]== SAFETY: Elysia validates the discriminated command shape at this
					// boundary; the library then guards the revision and derives the
					// deletion impact from the selections present in the transaction.
					const outcome = withDatabase(database, (connection) =>
						executePromptPresetCommand(connection, body),
					);
					return outcome.kind === "deleted"
						? { outcome: "deleted" as const, result: outcome.result }
						: { outcome: "applied" as const, preset: outcome.preset };
				} catch (error) {
					if (error instanceof StalePromptPresetRevisionError) {
						return status(409, {
							outcome: "conflict" as const,
							reason: "stale-revision" as const,
							expectedRevision: error.expectedRevision,
							actualRevision: error.actualRevision,
							currentPreset: error.currentPreset,
						});
					}
					if (error instanceof PromptPresetDeletionImpactChangedError) {
						return status(409, {
							outcome: "conflict" as const,
							reason: "deletion-impact" as const,
							currentPreset: error.currentPreset,
						});
					}
					if (error instanceof DefaultPromptPresetNotRemovableError) {
						return status(409, {
							outcome: "not-removable" as const,
							reason: error.message,
						});
					}
					if (error instanceof PromptPresetNotFoundError) {
						return notFoundResponse();
					}
					if (error instanceof InvalidPromptPresetCommandError) {
						return invalidResponse(error.message);
					}
					if (error instanceof InvalidPromptPresetOperationError) {
						return invalidResponse(error.message);
					}
					throw error;
				}
			},
			{
				body: promptPresetCommandBody,
				response: {
					200: promptPresetCommandApplied,
					409: promptPresetCommandConflict,
					404: notFoundOutcome,
					422: invalidOutcome,
				},
			},
		);
