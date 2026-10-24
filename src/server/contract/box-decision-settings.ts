import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { presentDomainError } from "./domain-error";
import { applyBoxDecisionSettings, readBoxDecisionSettings } from "../box/decision-settings";
import { boxDecisionSettings, boxDecisionSettingsApplied, boxDecisionSettingsCommandBody, boxDecisionSettingsConflict, boxDecisionSettingsInvalid, digestBoxParams as params } from "../../shared/contract/box";

const commandResponse = { 200: boxDecisionSettingsApplied, 409: boxDecisionSettingsConflict, 422: boxDecisionSettingsInvalid };

export const createBoxDecisionSettingsRoutes = (database: Database) => new Elysia()
	.get("/api/boxes/:box/decision-settings", ({ params }) => readBoxDecisionSettings(database, params.box), { params, response: boxDecisionSettings })
	.post("/api/boxes/:box/decision-settings/commands", ({ params, body }) => {
		try { return { outcome: "applied" as const, settings: applyBoxDecisionSettings(database, params.box, body) }; }
		catch (error) { return presentDomainError(error, commandResponse); }
	}, { params, body: boxDecisionSettingsCommandBody, response: commandResponse });
