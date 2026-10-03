import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import {
	CharacterNotFoundError,
	InvalidCharacterDefinitionError,
	StaleCharacterRevisionError,
} from "../character-library";
import { InvalidConversationCreationError } from "../conversation";

import { InvalidImageError, ingestUploads } from "../image";
import { createNativeConversation } from "../workflows";
import { invalidResponse, notFoundResponse, staleCharacterConflictResponse } from "./responses";
import { toConversationSummary } from "./projections";
import { characterConflict } from "../../shared/contract/character-library";
import {
	nativeConversationBody,
	nativeConversationResponse,
} from "../../shared/contract/native-conversation";
import { invalidOutcome, notFoundOutcome } from "../../shared/contract/outcomes";

export const createNativeConversationRoutes = (database: Database) =>
	new Elysia().post(
		"/api/conversations/native",
		async ({ body }) => {
			try {
				const images = await ingestUploads(body.images);
				const conversation = createNativeConversation(database, {
						images,
						name: body.name,
						humanSeat: body.humanSeat,
						modelSeat: body.modelSeat,
						timeZone: body.timeZone,
						locale: body.locale,
					});
				return {
					outcome: "created" as const,
					conversation: toConversationSummary(conversation),
				};
			} catch (error) {
				if (error instanceof StaleCharacterRevisionError) {
					return staleCharacterConflictResponse(error);
				}
				if (error instanceof CharacterNotFoundError) {
					return notFoundResponse();
				}
				if (
					error instanceof InvalidCharacterDefinitionError ||
					error instanceof InvalidConversationCreationError ||
					error instanceof InvalidImageError
				) {
					return invalidResponse(error.message);
				}
				throw error;
			}
		},
		{
			body: nativeConversationBody,
			response: {
				200: nativeConversationResponse,
				409: characterConflict,
				404: notFoundOutcome,
				422: invalidOutcome,
			},
		},
	);
