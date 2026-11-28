import { presentDomainError } from "./domain-error";
import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";

import { createSemanticTriggerSettingsModule } from "../lorebook/semantic-settings";
import { semanticTriggerSettingsCommandBody, semanticTriggerSettingsCommandResponse, semanticTriggerSettingsReadResponse } from "../../shared/contract/semantic-trigger-settings";

export const createSemanticTriggerSettingsRoutes = (database: Database) => new Elysia({ tags: ["Semantic triggers"] })
	.get("/api/semantic-trigger-settings", () => createSemanticTriggerSettingsModule(database).get(), { response: semanticTriggerSettingsReadResponse })
	.post("/api/semantic-trigger-settings/commands", ({ body }) => {
		try { return { outcome: "applied" as const, settings: createSemanticTriggerSettingsModule(database).apply(body) }; }
		catch (error) {
			return presentDomainError(error, semanticTriggerSettingsCommandResponse);
		}
	}, { body: semanticTriggerSettingsCommandBody, response: semanticTriggerSettingsCommandResponse });
