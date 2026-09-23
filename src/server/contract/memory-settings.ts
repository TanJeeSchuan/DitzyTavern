import type { Database } from "bun:sqlite";
import { Elysia, status } from "elysia";
import { withDatabase } from "../database/database";
import { createMemorySettingsModule, InvalidMemorySettingsError, StaleMemorySettingsError, type MemorySettingsModuleOptions } from "../memory";
import { memorySettingsApplied, memorySettingsCommandBody, memorySettingsConflict, memorySettingsInvalid, memorySettingsResponse } from "../../shared/contract/memory-settings";

export const createMemorySettingsRoutes = (database: Database | undefined, options: MemorySettingsModuleOptions = {}) => new Elysia()
	.get("/api/memory-settings", () => withDatabase(database, (connection) => createMemorySettingsModule(connection, options).get()), { response: memorySettingsResponse })
	.post("/api/memory-settings/commands", ({ body }) => {
		try {
			const settings = withDatabase(database, (connection) => {
				const module = createMemorySettingsModule(connection, options);
				switch (body.type) {
					case "apply": return module.apply(body);
					case "set-credential": return module.setCredential(body);
					case "reset-credential": return module.resetCredential(body);
				}
			});
			return { outcome: "applied" as const, settings };
		} catch (error) {
			if (error instanceof StaleMemorySettingsError) return status(409, { outcome: "conflict" as const, expectedRevision: error.expectedRevision, actualRevision: error.actualRevision, currentSettings: error.currentSettings });
			if (error instanceof InvalidMemorySettingsError) return status(422, { outcome: "invalid" as const, reason: error.message });
			if (error instanceof Error) return status(422, { outcome: "invalid" as const, reason: error.message });
			return status(422, { outcome: "invalid" as const, reason: "Memory Settings could not be saved." });
		}
	}, { body: memorySettingsCommandBody, response: { 200: memorySettingsApplied, 409: memorySettingsConflict, 422: memorySettingsInvalid } });
