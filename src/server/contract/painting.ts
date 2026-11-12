import type { Database } from "bun:sqlite";
import { Elysia, sse, status } from "elysia";
import { briefRequest, galleryRead, illustrationsRead, paintingCommand, paintingAccepted } from "../../shared/contract/painting";
import { conversationIdParams } from "../../shared/contract/conversation-schema";
import { invalidOutcome, notFoundOutcome, notPlayableOutcome } from "../../shared/contract/outcomes";
import { ModelClientGenerationError, ModelClientTransportError } from "../model-client";
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
			catch (error) { return presentDomainError(error, { 404: notFoundOutcome }); }
		}, { params: conversationIdParams, response: { 200: galleryRead, 404: notFoundOutcome } })
		.get("/api/conversations/:id/illustrations", ({ params }) => {
			try { return paintings.read(params.id); }
			catch (error) { return presentDomainError(error, readResponse); }
		}, { params: conversationIdParams, response: readResponse })
		.post("/api/conversations/:id/illustrations/commands", ({ params, body }) => {
			try { paintings.command(params.id, body); return { outcome: "accepted" as const }; }
			catch (error) { return presentDomainError(error, commandResponse); }
		}, { params: conversationIdParams, body: paintingCommand, response: commandResponse });
};
