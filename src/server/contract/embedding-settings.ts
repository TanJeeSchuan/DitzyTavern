import type { Database } from "bun:sqlite";
import { Elysia, status } from "elysia";
import { withDatabase } from "../database/database";
import {
	createEmbeddingSettingsModule,
	InvalidEmbeddingSettingsError,
	StaleEmbeddingSettingsError,
	validateEmbeddingSettings,
	type EmbeddingSettingsModuleOptions,
} from "../embedding-settings";
import { EmbeddingServiceError, requestEmbeddings } from "../embedding-settings/client";
import { queueAllMemoryIndexing } from "../memory/indexing";
import {
	embeddingSettingsApplied,
	embeddingSettingsCommandBody,
	embeddingSettingsConflict,
	embeddingSettingsInvalid,
	embeddingModelDiscoveryResponse,
	embeddingSettingsResponse,
	embeddingTestBody,
	embeddingTestResponse,
} from "../../shared/contract/embedding-settings";
import { discoverModels, type ModelFetch } from "../model-client";

export interface EmbeddingSettingsRouteOptions extends EmbeddingSettingsModuleOptions {
	readonly fetch?: ModelFetch;
}

const modelsUrlFor = (endpoint: string): string | null => {
	const url = new URL(endpoint);
	if (!url.pathname.endsWith("/embeddings")) return null;
	url.pathname = `${url.pathname.slice(0, -"embeddings".length)}models`;
	return url.toString();
};

export const createEmbeddingSettingsRoutes = (
	database: Database | undefined,
	options: EmbeddingSettingsRouteOptions = {},
) => new Elysia()
	.get("/api/embedding-settings", () => withDatabase(database, (connection) => createEmbeddingSettingsModule(connection, options).get()), { response: embeddingSettingsResponse })
	.post("/api/embedding-settings/discovery", async () => {
		const prepared = withDatabase(database, (connection) => {
			const module = createEmbeddingSettingsModule(connection, options);
			return { settings: module.get(), credential: module.getCredential() };
		});
		if (prepared.settings.endpoint.length === 0) return { outcome: "failure" as const, kind: "endpoint" as const, message: "Save an embedding endpoint before refreshing models." };
		const modelsUrl = modelsUrlFor(prepared.settings.endpoint);
		if (modelsUrl === null) return { outcome: "failure" as const, kind: "endpoint" as const, message: "Model refresh requires an embedding endpoint ending in /embeddings." };
		return discoverModels({
			profile: {
				displayName: "Embeddings",
				apiFormat: "chat-completions",
				requestUrl: prepared.settings.endpoint,
				modelsUrl,
				modelBackend: "automatic",
				adapter: "openai-compatible",
				outputTokenRepresentation: "automatic",
				timeoutMs: prepared.settings.deadlineMs,
				pinnedModels: [],
			},
			secrets: { credential: prepared.credential, headers: {} },
		}, { fetch: options.fetch });
	}, { response: embeddingModelDiscoveryResponse })
	.post("/api/embedding-settings/test", async ({ body, status }) => {
		try {
			const values = validateEmbeddingSettings(body);
			if (values.endpoint.length === 0) throw new InvalidEmbeddingSettingsError("An embedding endpoint and model are required for testing.");
			const storedCredential = withDatabase(database, (connection) => createEmbeddingSettingsModule(connection, options).getCredential());
			const vectors = await requestEmbeddings(["DitzyTavern embedding test"], {
				endpoint: values.endpoint,
				model: values.model,
				timeoutMs: values.deadlineMs,
				credential: body.credential?.trim() || storedCredential,
				fetch: options.fetch,
			});
			return { outcome: "success" as const, dimensions: vectors[0]?.length ?? 0 };
		} catch (error) {
			if (error instanceof InvalidEmbeddingSettingsError) return status(422, { outcome: "invalid" as const, reason: error.message });
			if (error instanceof EmbeddingServiceError) return { outcome: "failure" as const, kind: error.kind, message: error.message };
			return { outcome: "failure" as const, kind: "endpoint" as const, message: "Embedding service test could not be completed." };
		}
	}, { body: embeddingTestBody, response: { 200: embeddingTestResponse, 422: embeddingSettingsInvalid } })
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
