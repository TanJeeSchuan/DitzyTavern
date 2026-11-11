import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { imageModelSettings, imageModelCommand, imageModelApplied, imageModelConflict } from "../../shared/contract/image-model";
import { invalidOutcome } from "../../shared/contract/outcomes";
import { applyImageModelSettings, readImageModelSettings } from "../painting/image-model-settings";
import { presentDomainError } from "./domain-error";

const response = { 200: imageModelApplied, 409: imageModelConflict, 422: invalidOutcome };
export const createImageModelRoutes = (database: Database) => new Elysia()
	.get("/api/image-model", () => readImageModelSettings(database), { response: imageModelSettings })
	.post("/api/image-model/commands", ({ body }) => {
		try { return { outcome: "applied" as const, settings: applyImageModelSettings(database, body) }; }
		catch (error) { return presentDomainError(error, response); }
	}, { body: imageModelCommand, response });
