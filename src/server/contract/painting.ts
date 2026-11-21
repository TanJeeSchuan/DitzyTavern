import type { Database } from "bun:sqlite";
import { Elysia, sse, status } from "elysia";
import { briefRequest, briefResponse, galleryResponse, illustrationsResponse, paintingCommand, paintingCommandResponse } from "../../shared/contract/painting";
import { conversationIdParams } from "../../shared/contract/conversation-schema";
import { ModelClientGenerationError, ModelClientTransportError } from "../model-client";
import { writeBrief } from "../painting/brief";
import { createPaintingModule } from "../painting";
import type { ConversationRouteOptions } from "./conversation";
import { presentDomainError } from "./domain-error";

export const createPaintingRoutes = (database: Database, options: ConversationRouteOptions = {}) => {
	const paintings = createPaintingModule(database, options);
	return new Elysia()
		.post("/api/conversations/:id/brief", async ({ params, body, request }) => {
			const events = writeBrief(database, params.id, body, options, request.signal);
			try {
				const first = await events.next();
				return (async function* () {
					try {
						if (!first.done) yield sse({ data: first.value });
						for await (const event of events) yield sse({ data: event });
					} catch (error) {
						const failure = error instanceof ModelClientGenerationError || error instanceof ModelClientTransportError ? error : { kind: "transport", message: "The Brief stream could not finish. Try again." };
						yield sse({ data: { type: "failed", kind: failure.kind, message: failure.message } });
					} finally { await events.return(); }
				})();
			} catch (error) {
				if (error instanceof ModelClientGenerationError || error instanceof ModelClientTransportError) return status(422, { outcome: "invalid" as const, reason: error.message });
				return presentDomainError(error, briefResponse);
			}
		}, { params: conversationIdParams, body: briefRequest, response: briefResponse })
		.get("/api/conversations/:id/gallery", ({ params }) => {
			try { return paintings.gallery(params.id); }
			catch (error) { return presentDomainError(error, galleryResponse); }
		}, { params: conversationIdParams, response: galleryResponse })
		.get("/api/conversations/:id/illustrations", ({ params }) => {
			try { return paintings.read(params.id); }
			catch (error) { return presentDomainError(error, illustrationsResponse); }
		}, { params: conversationIdParams, response: illustrationsResponse })
		.post("/api/conversations/:id/illustrations/commands", ({ params, body }) => {
			try { paintings.command(params.id, body); return { outcome: "accepted" as const }; }
			catch (error) { return presentDomainError(error, paintingCommandResponse); }
		}, { params: conversationIdParams, body: paintingCommand, response: paintingCommandResponse });
};
