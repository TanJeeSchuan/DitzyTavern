import type { Database } from "bun:sqlite";
import { Elysia, status } from "elysia";
import { withDatabase } from "../database/database";
import {
	DefaultPromptPresetNotRemovableError,
	executePromptPresetCommand,
	InvalidPromptPresetCommandError,
	listPromptPresets,
	PromptPresetNotFoundError,
	StalePromptPresetRevisionError,
} from "../prompt-preset";
import {
	notFoundOutcome,
	invalidOutcome,
} from "../../shared/contract/outcomes";
import {
	promptPresetCommandApplied,
	promptPresetCommandBody,
	promptPresetCommandConflict,
	promptPresetListResponse,
} from "../../shared/contract/prompt-preset";

// ==[HUMAN APPROVED]== Thin typed adapter over the Prompt Preset library seam. The database
// is injected so tests can mount the same routes against a temporary store;
// production passes undefined to use the default connection per request.
export const createPromptPresetRoutes = (database: Database | undefined) =>
	new Elysia()
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
					if ("reassignedConversationCount" in outcome) {
						return {
							outcome: "applied" as const,
							result: {
								presetId: outcome.presetId,
								reassignedConversationCount: outcome.reassignedConversationCount,
							},
						};
					}
					return { outcome: "applied" as const, preset: outcome };
				} catch (error) {
					if (error instanceof StalePromptPresetRevisionError) {
						return status(409, {
							outcome: "conflict" as const,
							expectedRevision: error.expectedRevision,
							actualRevision: error.actualRevision,
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
						return status(404, { outcome: "not-found" as const });
					}
					if (error instanceof InvalidPromptPresetCommandError) {
						return status(422, { outcome: "invalid" as const, reason: error.message });
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
