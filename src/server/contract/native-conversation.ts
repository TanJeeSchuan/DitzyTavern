import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import {
	CharacterNotFoundError,
	InvalidCharacterDefinitionError,
	StaleCharacterRevisionError,
} from "../character-library";
import { InvalidConversationCreationError } from "../conversation";
import { withDatabase } from "../database/database";
import { createNativeConversation } from "../workflows";
import { toCharacterPayload } from "./character-library";
import { toConversationSummary } from "./payload";
import { characterConflict } from "../../shared/contract/character-library";
import {
	nativeConversationBody,
	nativeConversationResponse,
} from "../../shared/contract/native-conversation";
import { invalidOutcome, notFoundOutcome } from "../../shared/contract/outcomes";

export const createNativeConversationRoutes = (database: Database | undefined) =>
	new Elysia().post(
		"/api/conversations/native",
		({ body, status }) => {
			try {
				const conversation = withDatabase(database, (connection) =>
					createNativeConversation(connection, {
						name: body.name,
						humanSeat: body.humanSeat,
						modelSeat: body.modelSeat,
					}),
				);
				return {
					outcome: "created" as const,
					conversation: toConversationSummary(conversation),
				};
			} catch (error) {
				if (error instanceof StaleCharacterRevisionError) {
					return status(409, {
						outcome: "conflict" as const,
						expectedRevision: error.expectedRevision,
						actualRevision: error.actualRevision,
						currentCharacter: toCharacterPayload(error.currentCharacter),
					});
				}
				if (error instanceof CharacterNotFoundError) {
					return status(404, { outcome: "not-found" as const });
				}
				if (
					error instanceof InvalidCharacterDefinitionError ||
					error instanceof InvalidConversationCreationError
				) {
					return status(422, {
						outcome: "invalid" as const,
						reason: error.message,
					});
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
