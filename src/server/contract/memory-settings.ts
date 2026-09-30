import type { Database } from "bun:sqlite";
import { Elysia, status } from "elysia";
import { withDatabase } from "../database/database";
import { createMemorySettingsModule, InvalidMemorySettingsError, StaleMemorySettingsError } from "../memory";
import { memorySettingsApplied, memorySettingsCommandBody, memorySettingsConflict, memorySettingsResponse } from "../../shared/contract/memory-settings";
import { invalidOutcome } from "../../shared/contract/outcomes";

export const createMemorySettingsRoutes = (database: Database | undefined) => new Elysia()
	.get("/api/memory-settings", () => withDatabase(database, (connection) => createMemorySettingsModule(connection).get()), { response: memorySettingsResponse })
	.post("/api/memory-settings/commands", ({ body }) => {
		try {
			const settings = withDatabase(database, (connection) => createMemorySettingsModule(connection).apply(body));
			return { outcome: "applied" as const, settings };
		} catch (error) {
			if (error instanceof StaleMemorySettingsError) return status(409, { outcome: "conflict" as const, expectedRevision: error.expectedRevision, actualRevision: error.actualRevision, currentSettings: error.currentSettings });
			if (error instanceof InvalidMemorySettingsError) return status(422, { outcome: "invalid" as const, reason: error.message });
			if (error instanceof Error) return status(422, { outcome: "invalid" as const, reason: error.message });
			return status(422, { outcome: "invalid" as const, reason: "Memory Settings could not be saved." });
		}
	}, { body: memorySettingsCommandBody, response: { 200: memorySettingsApplied, 409: memorySettingsConflict, 422: invalidOutcome } });
