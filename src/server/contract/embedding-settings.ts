import type { Database } from "bun:sqlite";
import { Elysia, status } from "elysia";
import { withDatabase } from "../database/database";
import {
	createEmbeddingSettingsModule,
	InvalidEmbeddingSettingsError,
	StaleEmbeddingSettingsError,
	type EmbeddingSettingsModuleOptions,
} from "../embedding-settings";
import { queueAllMemoryIndexing } from "../memory/indexing";
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
				const previous = module.get();
				let next = previous;
				switch (body.type) {
					case "apply": next = module.apply(body); break;
					case "set-credential": next = module.setCredential(body); break;
					case "reset-credential": next = module.resetCredential(body); break;
				}
				if (previous.endpoint !== next.endpoint || previous.model !== next.model || previous.deadlineMs !== next.deadlineMs) {
					queueAllMemoryIndexing(connection, { endpoint: next.endpoint, model: next.model, deadlineMs: next.deadlineMs });
				}
				return next;
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
