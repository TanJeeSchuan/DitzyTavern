import type { Database } from "bun:sqlite";
import { Elysia, status } from "elysia";

import { InvalidSettingsError, StaleSettingsError } from "../revisioned-settings";
import { createMemorySettingsModule } from "../memory";
import { memorySettingsApplied, memorySettingsCommandBody, memorySettingsConflict, memorySettingsResponse } from "../../shared/contract/memory-settings";
import { invalidOutcome } from "../../shared/contract/outcomes";

export const createMemorySettingsRoutes = (database: Database) => new Elysia()
	.get("/api/memory-settings", () => createMemorySettingsModule(database).get(), { response: memorySettingsResponse })
	.post("/api/memory-settings/commands", ({ body }) => {
		try {
			const settings = createMemorySettingsModule(database).apply(body);
			return { outcome: "applied" as const, settings };
		} catch (error) {
			if (error instanceof StaleSettingsError) return status(409, { outcome: "conflict" as const, expectedRevision: error.expectedRevision, actualRevision: error.actualRevision, currentSettings: error.currentSettings });
			if (error instanceof InvalidSettingsError) return status(422, { outcome: "invalid" as const, reason: error.message });
			throw error;
		}
	}, { body: memorySettingsCommandBody, response: { 200: memorySettingsApplied, 409: memorySettingsConflict, 422: invalidOutcome } });
