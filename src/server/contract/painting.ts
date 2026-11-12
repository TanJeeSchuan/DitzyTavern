import type { Database } from "bun:sqlite";
import { Elysia, sse } from "elysia";
import { briefRequest, illustrationsRead, paintingCommand, paintingAccepted } from "../../shared/contract/painting";
import { conversationIdParams } from "../../shared/contract/conversation-schema";
import { invalidOutcome, notFoundOutcome, notPlayableOutcome } from "../../shared/contract/outcomes";
import { writeBrief } from "../painting/brief";
import { createPaintingModule } from "../painting";
import type { ConversationRouteOptions } from "./conversation";
import { presentDomainError } from "./domain-error";

export const createPaintingRoutes = (database: Database, options: ConversationRouteOptions = {}) => {
	const paintings = createPaintingModule(database, options);
	const readResponse = { 200: illustrationsRead, 404: notFoundOutcome };
	const briefResponse = { 404: notFoundOutcome, 409: notPlayableOutcome, 422: invalidOutcome };
	const commandResponse = { 200: paintingAccepted, 404: notFoundOutcome, 422: invalidOutcome };
	return new Elysia()
		.post("/api/conversations/:id/brief", async ({ params, body, request }) => {
			const events = writeBrief(database, params.id, body, options, request.signal);
			try {
				const first = await events.next();
				return (async function* () {
					try {
						if (!first.done) yield sse({ data: first.value });
						for await (const event of events) yield sse({ data: event });
					} catch {
						yield sse({ data: { type: "failed", kind: "transport", message: "The Brief stream could not finish. Try again." } });
					} finally { await events.return(); }
				})();
			} catch (error) { return presentDomainError(error, briefResponse); }
		}, { params: conversationIdParams, body: briefRequest, response: briefResponse })
		.get("/api/conversations/:id/illustrations", ({ params }) => {
			try { return paintings.read(params.id); }
			catch (error) { return presentDomainError(error, readResponse); }
		}, { params: conversationIdParams, response: readResponse })
		.post("/api/conversations/:id/illustrations/commands", ({ params, body }) => {
			try { paintings.command(params.id, body); return { outcome: "accepted" as const }; }
			catch (error) { return presentDomainError(error, commandResponse); }
		}, { params: conversationIdParams, body: paintingCommand, response: commandResponse });
};
