import type { Database } from "bun:sqlite";
import { Elysia, status } from "elysia";
import { InvalidSettingsError, StaleSettingsError } from "../revisioned-settings";
import { createSemanticTriggerSettingsModule } from "../lorebook/semantic-settings";
import { semanticTriggerSettings, semanticTriggerSettingsApplied, semanticTriggerSettingsCommandBody, semanticTriggerSettingsConflict, semanticTriggerSettingsInvalid } from "../../shared/contract/semantic-trigger-settings";

export const createSemanticTriggerSettingsRoutes = (database: Database) => new Elysia()
	.get("/api/semantic-trigger-settings", () => createSemanticTriggerSettingsModule(database).get(), { response: semanticTriggerSettings })
	.post("/api/semantic-trigger-settings/commands", ({ body }) => {
		try { return { outcome: "applied" as const, settings: createSemanticTriggerSettingsModule(database).apply(body) }; }
		catch (error) {
			if (error instanceof StaleSettingsError) return status(409, { outcome: "conflict" as const, expectedRevision: error.expectedRevision, actualRevision: error.actualRevision, currentSettings: error.currentSettings });
			if (error instanceof InvalidSettingsError) return status(422, { outcome: "invalid" as const, reason: error.message });
			throw error;
		}
	}, { body: semanticTriggerSettingsCommandBody, response: { 200: semanticTriggerSettingsApplied, 409: semanticTriggerSettingsConflict, 422: semanticTriggerSettingsInvalid } });
