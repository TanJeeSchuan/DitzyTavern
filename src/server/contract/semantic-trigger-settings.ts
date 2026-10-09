import { presentDomainError } from "./domain-error";
import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";

import { createSemanticTriggerSettingsModule } from "../lorebook/semantic-settings";
import { semanticTriggerSettings, semanticTriggerSettingsApplied, semanticTriggerSettingsCommandBody, semanticTriggerSettingsConflict, semanticTriggerSettingsInvalid } from "../../shared/contract/semantic-trigger-settings";

const commandResponse = { 200: semanticTriggerSettingsApplied, 409: semanticTriggerSettingsConflict, 422: semanticTriggerSettingsInvalid };

export const createSemanticTriggerSettingsRoutes = (database: Database) => new Elysia()
	.get("/api/semantic-trigger-settings", () => createSemanticTriggerSettingsModule(database).get(), { response: semanticTriggerSettings })
	.post("/api/semantic-trigger-settings/commands", ({ body }) => {
		try { return { outcome: "applied" as const, settings: createSemanticTriggerSettingsModule(database).apply(body) }; }
		catch (error) {
			return presentDomainError(error, commandResponse);
		}
	}, { body: semanticTriggerSettingsCommandBody, response: commandResponse });
