import type { Database } from "bun:sqlite";
import { Elysia, status } from "elysia";
import { withDatabase } from "../database/database";
import { createTypesafeSettingsModule, InvalidTypesafeSettingsError, StaleTypesafeSettingsError, type TypesafeSettingsModuleOptions } from "../typesafe";
import { typesafeSettings, typesafeSettingsApplied, typesafeSettingsCommandBody, typesafeSettingsConflict, typesafeSettingsInvalid } from "../../shared/contract/typesafe";

export const createTypesafeSettingsRoutes = (database: Database | undefined, options: TypesafeSettingsModuleOptions = {}) => new Elysia()
	.get("/api/typesafe-settings", () => withDatabase(database, (connection) => createTypesafeSettingsModule(connection, options).get()), { response: typesafeSettings })
	.post("/api/typesafe-settings/commands", ({ body }) => {
		try {
			const settings = withDatabase(database, (connection) => {
				const module = createTypesafeSettingsModule(connection, options);
				return body.type === "apply" ? module.apply(body) : module.resetCredential(body);
			});
			return { outcome: "applied" as const, settings };
		} catch (error) {
			if (error instanceof StaleTypesafeSettingsError) return status(409, { outcome: "conflict" as const, expectedRevision: error.expectedRevision, actualRevision: error.actualRevision, currentSettings: error.currentSettings });
			if (error instanceof InvalidTypesafeSettingsError) return status(422, { outcome: "invalid" as const, reason: error.message });
			return status(422, { outcome: "invalid" as const, reason: "Typesafe Settings could not be saved." });
		}
	}, { body: typesafeSettingsCommandBody, response: { 200: typesafeSettingsApplied, 409: typesafeSettingsConflict, 422: typesafeSettingsInvalid } });
