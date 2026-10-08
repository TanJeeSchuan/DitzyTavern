import { presentDomainError } from "./domain-error";
import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";

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
			return presentDomainError(error, { 409: memorySettingsConflict, 422: invalidOutcome });
		}
	}, { body: memorySettingsCommandBody, response: { 200: memorySettingsApplied, 409: memorySettingsConflict, 422: invalidOutcome } });
