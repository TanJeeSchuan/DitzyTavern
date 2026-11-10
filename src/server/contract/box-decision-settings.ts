import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { presentDomainError } from "./domain-error";
import { applyBoxDecisionSettings, readBoxDecisionSettings } from "../box/decision-settings";
import { applyBoxDelegateSettings, readBoxDelegateSettings } from "../box/delegate-settings";
import {
	boxDecisionSettings, boxDecisionSettingsApplied, boxDecisionSettingsCommandBody, boxDecisionSettingsConflict, boxDecisionSettingsInvalid,
	boxDelegateSettings, boxDelegateSettingsApplied, boxDelegateSettingsCommandBody, boxDelegateSettingsConflict, boxParams as params, isDelegateBox, isDigestBox,
} from "../../shared/contract/box";
import { notFoundOutcome } from "../../shared/contract/outcomes";
import { notFoundResponse } from "./responses";

const commandResponse = { 200: boxDecisionSettingsApplied, 404: notFoundOutcome, 409: boxDecisionSettingsConflict, 422: boxDecisionSettingsInvalid };
const delegateResponse = { 200: boxDelegateSettingsApplied, 404: notFoundOutcome, 409: boxDelegateSettingsConflict, 422: boxDecisionSettingsInvalid };

export const createBoxDecisionSettingsRoutes = (database: Database) => new Elysia()
	.get("/api/boxes/:box/decision-settings", ({ params }) => isDigestBox(params.box) ? readBoxDecisionSettings(database, params.box) : notFoundResponse(),
		{ params, response: { 200: boxDecisionSettings, 404: notFoundOutcome } })
	.post("/api/boxes/:box/decision-settings/commands", ({ params, body }) => {
		if (!isDigestBox(params.box)) return notFoundResponse();
		try { return { outcome: "applied" as const, settings: applyBoxDecisionSettings(database, params.box, body) }; }
		catch (error) { return presentDomainError(error, commandResponse); }
	}, { params, body: boxDecisionSettingsCommandBody, response: commandResponse })
	.get("/api/boxes/:box/delegate-settings", ({ params }) => isDelegateBox(params.box) ? readBoxDelegateSettings(database, params.box) : notFoundResponse(),
		{ params, response: { 200: boxDelegateSettings, 404: notFoundOutcome } })
	.post("/api/boxes/:box/delegate-settings/commands", ({ params, body }) => {
		if (!isDelegateBox(params.box)) return notFoundResponse();
		try { return { outcome: "applied" as const, settings: applyBoxDelegateSettings(database, params.box, body) }; }
		catch (error) { return presentDomainError(error, delegateResponse); }
	}, { params, body: boxDelegateSettingsCommandBody, response: delegateResponse });
