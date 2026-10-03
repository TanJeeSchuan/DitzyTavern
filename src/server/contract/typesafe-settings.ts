import type { Database } from "bun:sqlite";
import { Elysia, status } from "elysia";

import { InvalidSettingsError, StaleSettingsError } from "../revisioned-settings";
import { createTypesafeSettingsModule, type TypesafeSettingsModuleOptions } from "../typesafe";
import { typesafeSettings, typesafeSettingsApplied, typesafeSettingsCommandBody, typesafeSettingsConflict, typesafeSettingsInvalid } from "../../shared/contract/typesafe";

export const createTypesafeSettingsRoutes = (database: Database, options: TypesafeSettingsModuleOptions = {}) => new Elysia()
	.get("/api/typesafe-settings", () => createTypesafeSettingsModule(database, options).get(), { response: typesafeSettings })
	.post("/api/typesafe-settings/commands", ({ body }) => {
		try {
			return { outcome: "applied" as const, settings: createTypesafeSettingsModule(database, options).apply(body) };
		} catch (error) {
			if (error instanceof StaleSettingsError) return status(409, { outcome: "conflict" as const, expectedRevision: error.expectedRevision, actualRevision: error.actualRevision, currentSettings: error.currentSettings });
			if (error instanceof InvalidSettingsError) return status(422, { outcome: "invalid" as const, reason: error.message });
			throw error;
		}
	}, { body: typesafeSettingsCommandBody, response: { 200: typesafeSettingsApplied, 409: typesafeSettingsConflict, 422: typesafeSettingsInvalid } });
