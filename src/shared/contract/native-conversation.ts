import type { Database } from "bun:sqlite";
import { Elysia, t } from "elysia";
import {
	CharacterNotFoundError,
	InvalidCharacterDefinitionError,
	StaleCharacterRevisionError,
} from "../../server/character-library";
import { InvalidConversationCreationError } from "../../server/conversation";
import { withDatabase } from "../../server/database/database";
import { createNativeConversation } from "../../server/workflows";
import {
	characterSnapshot,
	toCharacterPayload,
} from "./character-library";
import {
	conversationSummary,
	participantPrompt,
	toConversationSummary,
} from "./conversation-schema";

const newChatSeatSchema = t.Union([
	t.Object({
		type: t.Literal("character"),
		characterId: t.Integer(),
		expectedRevision: t.Integer(),
	}),
	t.Object({
		type: t.Literal("adhoc"),
		definition: t.Object({
			name: t.String(),
			prompt: participantPrompt,
			openings: t.Array(t.String()),
		}),
	}),
]);

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
			body: t.Object({
				name: t.String(),
				humanSeat: newChatSeatSchema,
				modelSeat: newChatSeatSchema,
			}),
			response: {
				200: t.Object({
					outcome: t.Literal("created"),
					conversation: conversationSummary,
				}),
				409: t.Object({
					outcome: t.Literal("conflict"),
					expectedRevision: t.Integer(),
					actualRevision: t.Integer(),
					currentCharacter: characterSnapshot,
				}),
				404: t.Object({ outcome: t.Literal("not-found") }),
				422: t.Object({
					outcome: t.Literal("invalid"),
					reason: t.String(),
				}),
			},
		},
	);
