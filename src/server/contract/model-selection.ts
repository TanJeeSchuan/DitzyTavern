import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { modelSelectionSettings, modelSelectionCommand, modelSelectionApplied, modelSelectionConflict } from "../../shared/contract/model-selection";
import { invalidOutcome } from "../../shared/contract/outcomes";
import { applyImageModelSettings, readImageModelSettings } from "../painting/image-model-settings";
import { presentDomainError } from "./domain-error";

import { applyDescribingModelSettings, readDescribingModelSettings } from "../painting/describing-model-settings";

const response = { 200: modelSelectionApplied, 409: modelSelectionConflict, 422: invalidOutcome };
export const createModelSelectionRoutes = (database: Database) => new Elysia()
	.get("/api/describing-model", () => readDescribingModelSettings(database), { response: modelSelectionSettings })
	.post("/api/describing-model/commands", ({ body }) => {
		try { return { outcome: "applied" as const, settings: applyDescribingModelSettings(database, body) }; }
		catch (error) { return presentDomainError(error, response); }
	}, { body: modelSelectionCommand, response })
	.get("/api/image-model", () => readImageModelSettings(database), { response: modelSelectionSettings })
	.post("/api/image-model/commands", ({ body }) => {
		try { return { outcome: "applied" as const, settings: applyImageModelSettings(database, body) }; }
		catch (error) { return presentDomainError(error, response); }
	}, { body: modelSelectionCommand, response });
