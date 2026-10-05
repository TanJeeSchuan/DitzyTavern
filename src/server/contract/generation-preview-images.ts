import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { InvalidConversationCommandError } from "../conversation";
import { resolveGenerationPreviewImages } from "../workflows/generation-preview";
import { conversationIdParams, generationPreviewImagesBody, generationPreviewImages } from "../../shared/contract/conversation-schema";
import { invalidOutcome } from "../../shared/contract/outcomes";

export const createGenerationPreviewImageRoutes = (database: Database) => new Elysia().post(
	"/api/conversations/:id/generations/preview/images",
	({ params, body, status }) => {
		try {
			return { images: resolveGenerationPreviewImages(database, params.id, body.previewId, body.promptPlan) };
		} catch (error) {
			if (error instanceof InvalidConversationCommandError) return status(422, { outcome: "invalid" as const, reason: error.message });
			throw error;
		}
	},
	{ params: conversationIdParams, body: generationPreviewImagesBody, response: { 200: generationPreviewImages, 422: invalidOutcome } },
);
