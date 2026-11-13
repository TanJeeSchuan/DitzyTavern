import type { Database } from "bun:sqlite";
import { Elysia, status } from "elysia";
import { describeRequest, description } from "../../shared/contract/describe";
import { invalidOutcome } from "../../shared/contract/outcomes";
import { describeImages } from "../painting/describe";
import { ModelClientGenerationError, ModelClientTransportError } from "../model-client";
import type { ConversationRouteOptions } from "./conversation";
import { presentDomainError } from "./domain-error";

const response = { 200: description, 422: invalidOutcome };
export const createDescribeRoutes = (database: Database, options: ConversationRouteOptions = {}) => new Elysia()
	.post("/api/describe", async ({ body, request }) => {
		try { return await describeImages(database, body, options, request.signal); }
		catch (error) {
			if (error instanceof ModelClientGenerationError || error instanceof ModelClientTransportError) return status(422, { outcome: "invalid" as const, reason: error.message });
			return presentDomainError(error, response);
		}
	}, { body: describeRequest, response });
