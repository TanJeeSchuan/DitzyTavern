import type { Database } from "bun:sqlite";
import { Elysia, t } from "elysia";
import {
	CharacterNotFoundError,
	InvalidCharacterDefinitionError,
	StaleCharacterRevisionError,
} from "../../server/character-library";
import {
	ConversationNotFoundError,
	ConversationNotPlayableError,
	InvalidConversationCommandError,
	ParticipantNotFoundError,
	ParticipantNotRemovableError,
	createConversationModule,
	StaleConversationRevisionError,
} from "../../server/conversation";
import { withDatabase } from "../../server/database/database";
import {
	addCharacterToCast,
	saveParticipantAsCharacter,
} from "../../server/workflows";
import {
	characterSnapshot,
	toCharacterPayload,
} from "./character-library";
import {
	characterConflict,
	chatHistoryPage,
	conversationCommandBody,
	conversationConflict,
	conversationSummary,
	invalidOutcome,
	notFoundOutcome,
	notPlayableOutcome,
	notRemovableOutcome,
	staleConversationConflict,
	toConversationSummary,
} from "./conversation-schema";

// Thin typed adapters over the deep Conversation seam: snapshot reads,
// revisioned command execution, and the explicit Character-to-Cast workflow
// (which itself composes Character Library and Conversation capabilities in
// one transaction). Routes never coordinate tables or reproduce domain
// rules; they map typed outcomes to typed transport results.
export const createConversationRoutes = (database: Database | undefined) =>
	new Elysia()
		.get(
			"/api/conversations/:id",
			({ params, status }) => {
				const conversation = withDatabase(database, (connection) =>
					createConversationModule(connection).getSnapshot(params.id),
				);
				if (conversation === undefined) {
					return status(404, { outcome: "not-found" as const });
				}
				return toConversationSummary(conversation);
			},
			{
				params: t.Object({ id: t.Numeric() }),
				response: {
					200: conversationSummary,
					404: notFoundOutcome,
				},
			},
		)
		.get(
			"/api/conversations/:id/history",
			({ params, query, status }) => {
				const history = withDatabase(database, (connection) =>
					createConversationModule(connection).readHistory(params.id, {
						page: query.page,
						pageSize: query.pageSize,
					}),
				);
				if (history === undefined) {
					return status(404, { outcome: "not-found" as const });
				}
				return history;
			},
			{
				params: t.Object({ id: t.Numeric() }),
				query: t.Object({
					page: t.Optional(t.Numeric()),
					pageSize: t.Optional(t.Numeric()),
				}),
				response: {
					200: chatHistoryPage,
					404: notFoundOutcome,
				},
			},
		)
		.post(
			"/api/conversations/:id/commands",
			({ params, body, status }) => {
				try {
					const conversation = withDatabase(database, (connection) =>
						createConversationModule(connection).execute({
							conversationId: params.id,
							expectedRevision: body.expectedRevision,
							action: body.action,
						}),
					);
					return {
						outcome: "applied" as const,
						conversation: toConversationSummary(conversation),
					};
				} catch (error) {
					if (error instanceof StaleConversationRevisionError) {
						const conflict = staleConversationConflict(
							database,
							params.id,
							error,
						);
						if (conflict.outcome === "not-found") {
							return status(404, conflict);
						}
						return status(409, conflict);
					}
					if (error instanceof ConversationNotFoundError) {
						return status(404, { outcome: "not-found" as const });
					}
					if (error instanceof ConversationNotPlayableError) {
						return status(409, {
							outcome: "not-playable" as const,
							reason: error.message,
						});
					}
					if (error instanceof ParticipantNotRemovableError) {
						return status(409, {
							outcome: "not-removable" as const,
							reason: error.reason,
						});
					}
					if (error instanceof InvalidConversationCommandError) {
						return status(422, {
							outcome: "invalid" as const,
							reason: error.message,
						});
					}
					throw error;
				}
			},
			{
				params: t.Object({ id: t.Numeric() }),
				body: conversationCommandBody,
				response: {
					200: t.Object({
						outcome: t.Literal("applied"),
						conversation: conversationSummary,
					}),
					409: t.Union([conversationConflict, notPlayableOutcome, notRemovableOutcome]),
					404: notFoundOutcome,
					422: invalidOutcome,
				},
			},
		)
		.post(
			"/api/conversations/:id/cast/characters",
			({ params, body, status }) => {
				try {
					const conversation = withDatabase(database, (connection) =>
						addCharacterToCast(connection, {
							conversationId: params.id,
							expectedConversationRevision: body.expectedConversationRevision,
							characterId: body.characterId,
							expectedCharacterRevision: body.expectedCharacterRevision,
						}),
					);
					return {
						outcome: "applied" as const,
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
					if (error instanceof StaleConversationRevisionError) {
						const conflict = staleConversationConflict(
							database,
							params.id,
							error,
						);
						if (conflict.outcome === "not-found") {
							return status(404, conflict);
						}
						return status(409, conflict);
					}
					if (
						error instanceof ConversationNotFoundError ||
						error instanceof CharacterNotFoundError
					) {
						return status(404, { outcome: "not-found" as const });
					}
					if (error instanceof InvalidConversationCommandError) {
						return status(422, {
							outcome: "invalid" as const,
							reason: error.message,
						});
					}
					throw error;
				}
			},
			{
				params: t.Object({ id: t.Numeric() }),
				body: t.Object({
					expectedConversationRevision: t.Integer(),
					characterId: t.Integer(),
					expectedCharacterRevision: t.Integer(),
				}),
				response: {
					200: t.Object({
						outcome: t.Literal("applied"),
						conversation: conversationSummary,
					}),
					409: t.Union([characterConflict, conversationConflict]),
					404: notFoundOutcome,
					422: invalidOutcome,
				},
			},
		)
		.post(
			"/api/conversations/:id/cast/participants/:participantId/characters",
			({ params, body, status }) => {
				try {
					const { character } = withDatabase(database, (connection) =>
						saveParticipantAsCharacter(connection, {
							conversationId: params.id,
							expectedConversationRevision:
								body.expectedConversationRevision,
							participantId: params.participantId,
						}),
					);
					return {
						outcome: "applied" as const,
						character: toCharacterPayload(character),
					};
				} catch (error) {
					if (error instanceof StaleConversationRevisionError) {
						const conflict = staleConversationConflict(
							database,
							params.id,
							error,
						);
						if (conflict.outcome === "not-found") {
							return status(404, conflict);
						}
						return status(409, conflict);
					}
					if (
						error instanceof ConversationNotFoundError ||
						error instanceof ParticipantNotFoundError
					) {
						return status(404, { outcome: "not-found" as const });
					}
					if (error instanceof InvalidCharacterDefinitionError) {
						return status(422, {
							outcome: "invalid" as const,
							reason: error.message,
						});
					}
					throw error;
				}
			},
			{
				params: t.Object({ id: t.Numeric(), participantId: t.Numeric() }),
				body: t.Object({
					expectedConversationRevision: t.Integer(),
				}),
				response: {
					200: t.Object({
						outcome: t.Literal("applied"),
						character: characterSnapshot,
					}),
					409: conversationConflict,
					404: notFoundOutcome,
					422: invalidOutcome,
				},
			},
		);
