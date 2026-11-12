import type { Database } from "bun:sqlite";
import { Elysia, sse } from "elysia";
import { briefRequest, illustrationsRead, paintingCommand, paintingAccepted } from "../../shared/contract/painting";
import { conversationIdParams } from "../../shared/contract/conversation-schema";
import { invalidOutcome, notFoundOutcome } from "../../shared/contract/outcomes";
import { writeBrief } from "../painting/brief";
import { createPaintingModule } from "../painting";
import type { ConversationRouteOptions } from "./conversation";
import { presentDomainError } from "./domain-error";

export const createPaintingRoutes = (database: Database, options: ConversationRouteOptions = {}) => {
	const paintings = createPaintingModule(database, options);
	const readResponse = { 200: illustrationsRead, 404: notFoundOutcome };
	const commandResponse = { 200: paintingAccepted, 404: notFoundOutcome, 422: invalidOutcome };
	return new Elysia()
		.post("/api/conversations/:id/brief", async function* ({ params, body, request }) {
			try {
				for await (const event of writeBrief(database, params.id, body, options, request.signal)) yield sse({ data: event });
			} catch (error) {
				yield sse({ data: { type: "failed", kind: "transport", message: error instanceof Error ? error.message : "The Brief could not be written." } });
			}
		}, { params: conversationIdParams, body: briefRequest })
		.get("/api/conversations/:id/illustrations", ({ params }) => {
			try { return paintings.read(params.id); }
			catch (error) { return presentDomainError(error, readResponse); }
		}, { params: conversationIdParams, response: readResponse })
		.post("/api/conversations/:id/illustrations/commands", ({ params, body }) => {
			try { paintings.command(params.id, body); return { outcome: "accepted" as const }; }
			catch (error) { return presentDomainError(error, commandResponse); }
		}, { params: conversationIdParams, body: paintingCommand, response: commandResponse });
};
