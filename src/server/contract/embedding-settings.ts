import type { Database } from "bun:sqlite";
import { Elysia, status } from "elysia";
import { withDatabase } from "../database/database";
import {
	createEmbeddingSettingsModule,
	InvalidEmbeddingSettingsError,
	StaleEmbeddingSettingsError,
	type EmbeddingSettingsModuleOptions,
} from "../embedding-settings";
import {
	embeddingSettingsApplied,
	embeddingSettingsCommandBody,
	embeddingSettingsConflict,
	embeddingSettingsInvalid,
	embeddingSettingsResponse,
} from "../../shared/contract/embedding-settings";

export interface EmbeddingSettingsRouteOptions extends EmbeddingSettingsModuleOptions {}

export const createEmbeddingSettingsRoutes = (
	database: Database | undefined,
	options: EmbeddingSettingsRouteOptions = {},
) => new Elysia()
	.get("/api/embedding-settings", () => withDatabase(database, (connection) => createEmbeddingSettingsModule(connection, options).get()), { response: embeddingSettingsResponse })
	.post("/api/embedding-settings/commands", ({ body }) => {
		try {
			const settings = withDatabase(database, (connection) => {
				const module = createEmbeddingSettingsModule(connection, options);
				switch (body.type) {
					case "apply": return module.apply(body);
					case "set-credential": return module.setCredential(body);
					case "reset-credential": return module.resetCredential(body);
				}
			});
			return { outcome: "applied" as const, settings };
		} catch (error) {
			if (error instanceof StaleEmbeddingSettingsError) return status(409, {
				outcome: "conflict" as const,
				expectedRevision: error.expectedRevision,
				actualRevision: error.actualRevision,
				currentSettings: error.currentSettings,
			});
			if (error instanceof InvalidEmbeddingSettingsError || error instanceof Error) return status(422, {
				outcome: "invalid" as const,
				reason: error.message,
			});
			return status(422, { outcome: "invalid" as const, reason: "Embedding Settings could not be saved." });
		}
	}, { body: embeddingSettingsCommandBody, response: { 200: embeddingSettingsApplied, 409: embeddingSettingsConflict, 422: embeddingSettingsInvalid } });

