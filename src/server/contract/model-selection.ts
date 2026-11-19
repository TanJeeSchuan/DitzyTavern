import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { modelSelectionCommand, modelSelectionCommandResponse, modelSelectionReadResponse } from "../../shared/contract/model-selection";
import { applyImageModelSettings, readImageModelSettings } from "../painting/image-model-settings";
import { presentDomainError } from "./domain-error";

import { applyDescribingModelSettings, readDescribingModelSettings } from "../painting/describing-model-settings";

export const createModelSelectionRoutes = (database: Database) => new Elysia()
	.get("/api/describing-model", () => readDescribingModelSettings(database), { response: modelSelectionReadResponse })
	.post("/api/describing-model/commands", ({ body }) => {
		try { return { outcome: "applied" as const, settings: applyDescribingModelSettings(database, body) }; }
		catch (error) { return presentDomainError(error, modelSelectionCommandResponse); }
	}, { body: modelSelectionCommand, response: modelSelectionCommandResponse })
	.get("/api/image-model", () => readImageModelSettings(database), { response: modelSelectionReadResponse })
	.post("/api/image-model/commands", ({ body }) => {
		try { return { outcome: "applied" as const, settings: applyImageModelSettings(database, body) }; }
		catch (error) { return presentDomainError(error, modelSelectionCommandResponse); }
	}, { body: modelSelectionCommand, response: modelSelectionCommandResponse });
