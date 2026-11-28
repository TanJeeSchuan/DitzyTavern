import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { presentDomainError } from "./domain-error";
import { applyBoxDecisionSettings, readBoxDecisionSettings } from "../box/decision-settings";
import { applyBoxDelegateSettings, readBoxDelegateSettings } from "../box/delegate-settings";
import {
	boxDecisionSettingsCommandBody, boxDecisionSettingsCommandResponse, boxDecisionSettingsReadResponse,
	DEFAULT_BOX_DELEGATE, boxDelegateSettingsCommandBody, boxDelegateSettingsCommandResponse, boxDelegateSettingsReadResponse, boxParams as params, isDelegateBox, isDigestBox,
} from "../../shared/contract/box";
import { notFoundResponse } from "./responses";

export const createBoxDecisionSettingsRoutes = (database: Database) => new Elysia({ tags: ["Boxes"] })
	.get("/api/boxes/:box/decision-settings", ({ params }) => isDigestBox(params.box) ? readBoxDecisionSettings(database, params.box) : notFoundResponse(),
		{ params, response: boxDecisionSettingsReadResponse })
	.post("/api/boxes/:box/decision-settings/commands", ({ params, body }) => {
		if (!isDigestBox(params.box)) return notFoundResponse();
		try { return { outcome: "applied" as const, settings: applyBoxDecisionSettings(database, params.box, body) }; }
		catch (error) { return presentDomainError(error, boxDecisionSettingsCommandResponse); }
	}, { params, body: boxDecisionSettingsCommandBody, response: boxDecisionSettingsCommandResponse })
	.get("/api/boxes/:box/delegate-settings", ({ params }) => (params.box === DEFAULT_BOX_DELEGATE || isDelegateBox(params.box)) ? readBoxDelegateSettings(database, params.box) : notFoundResponse(),
		{ params, response: boxDelegateSettingsReadResponse })
	.post("/api/boxes/:box/delegate-settings/commands", ({ params, body }) => {
		if (params.box !== DEFAULT_BOX_DELEGATE && !isDelegateBox(params.box)) return notFoundResponse();
		try { return { outcome: "applied" as const, settings: applyBoxDelegateSettings(database, params.box, body) }; }
		catch (error) { return presentDomainError(error, boxDelegateSettingsCommandResponse); }
	}, { params, body: boxDelegateSettingsCommandBody, response: boxDelegateSettingsCommandResponse });
