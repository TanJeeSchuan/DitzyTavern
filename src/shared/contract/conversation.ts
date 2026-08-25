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
	type ConversationAction,
	type ConversationGenerationSettings,
	type ConversationSnapshot,
} from "../../server/conversation";
import {
	createConnectionSettingsModule,
	type ConnectionSettingsModuleOptions,
} from "../../server/connection-settings";
import {
	createModelClient,
	ModelClientGenerationError,
	ModelClientTransportError,
	type ModelFetch,
} from "../../server/model-client";
import { withDatabase } from "../../server/database/database";
import {
	addCharacterToCast,
	generateReply,
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
	conversationGenerationSettings,
	conversationSummary,
	generationVariant,
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
export interface ConversationRouteOptions extends ConnectionSettingsModuleOptions {
	readonly fetch?: ModelFetch;
}

type GenerationSsePayload =
	| import("../../server/model-client").ModelClientEvent
	| ReturnType<typeof toGenerationPayload>
	| { readonly outcome: "not-found" }
	| { readonly outcome: "unconfigured"; readonly reason: string }
	| { readonly outcome: "failed"; readonly reason: string }
	| { readonly outcome: "not-playable"; readonly reason: string }
	| { readonly outcome: "invalid"; readonly reason: string };

export const createConversationRoutes = (
	database: Database | undefined,
	options: ConversationRouteOptions = {},
) =>
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
		.get(
			"/api/conversations/:id/generation-settings",
			({ params, status }) => {
				const settings = withDatabase(database, (connection) =>
					createConversationModule(connection).getGenerationSettings(params.id),
				);
				if (settings === undefined) {
					return status(404, { outcome: "not-found" as const });
				}
				return toGenerationSettingsPayload(settings);
			},
			{
				params: t.Object({ id: t.Numeric() }),
				response: {
					200: conversationGenerationSettings,
					404: notFoundOutcome,
				},
			},
		)
		.post(
			"/api/conversations/:id/generate",
			async ({ params, status, request }) => {
				try {
					return await withDatabase(database, async (connection) => {
						const conversation = createConversationModule(connection);
						const current = conversation.getSnapshot(params.id);
						if (current === undefined) {
							return status(404, { outcome: "not-found" as const });
						}
						const connectionSettings = createConnectionSettingsModule(
							connection,
							options,
						).get();
						if (connectionSettings.activeProfileId === null) {
							return status(409, {
								outcome: "unconfigured" as const,
								reason: "An active Connection Profile is required for Generation.",
							});
						}
						const profile = connectionSettings.profiles.find(
							(entry) => entry.id === connectionSettings.activeProfileId,
						);
						if (profile === undefined) {
							return status(409, {
								outcome: "unconfigured" as const,
								reason: "The active Connection Profile is unavailable.",
							});
						}
						const client = createModelClient({
							profile,
							secrets: connectionSettingsModuleSecrets(
								connection,
								profile.id,
								options,
							),
							fetch: options.fetch,
						});
						const generated = await generateReply(connection, {
							conversationId: params.id,
							modelClient: client,
							connection: {
								profileId: profile.id,
								settingsRevision: connectionSettings.revision,
								backend: "ai-sdk",
								adapter: profile.adapter,
							},
							signal: request.signal,
						});
						return toGenerationPayload(generated);
					});
				} catch (error) {
					if (error instanceof ConversationNotFoundError) {
						return status(404, { outcome: "not-found" as const });
					}
					if (error instanceof ConversationNotPlayableError) {
						return status(409, {
							outcome: "not-playable" as const,
							reason: error.message,
						});
					}
					if (error instanceof ModelClientGenerationError) {
						return status(502, {
							outcome: "failed" as const,
							reason: error.message,
						});
					}
					if (error instanceof ModelClientTransportError) {
						return status(502, {
							outcome: "failed" as const,
							reason: error.message,
						});
					}
					if (error instanceof Error) {
						return status(422, { outcome: "invalid" as const, reason: error.message });
					}
					throw error;
				}
			},
			{
				params: t.Object({ id: t.Numeric() }),
				body: t.Object({}),
				response: {
					200: t.Object({
						outcome: t.Literal("applied"),
						conversation: conversationSummary,
						variant: generationVariant,
					}),
					409: t.Union([notPlayableOutcome, t.Object({
						outcome: t.Literal("unconfigured"),
						reason: t.String(),
					})]),
					404: notFoundOutcome,
					422: invalidOutcome,
					502: t.Object({ outcome: t.Literal("failed"), reason: t.String() }),
				},
			},
		)
		.post(
			"/api/conversations/:id/generate/stream",
			({ params, request }) => {
				const encoder = new TextEncoder();
				const frame = (type: string, data: GenerationSsePayload) =>
					`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						const emit = (type: string, data: GenerationSsePayload) => {
							try {
								controller.enqueue(encoder.encode(frame(type, data)));
							} catch {
								// A disconnected browser already aborts the request; no
								// second write or retry is attempted.
							}
						};
						void withDatabase(database, async (connection) => {
							try {
								const conversation = createConversationModule(connection);
								const current = conversation.getSnapshot(params.id);
								if (current === undefined) {
									emit("error", { outcome: "not-found" });
									return;
								}
								const connectionSettings = createConnectionSettingsModule(connection, options).get();
								if (connectionSettings.activeProfileId === null) {
									emit("error", { outcome: "unconfigured", reason: "An active Connection Profile is required for Generation." });
									return;
								}
								const profile = connectionSettings.profiles.find((entry) => entry.id === connectionSettings.activeProfileId);
								if (profile === undefined) {
									emit("error", { outcome: "unconfigured", reason: "The active Connection Profile is unavailable." });
									return;
								}
								const client = createModelClient({
									profile,
									secrets: connectionSettingsModuleSecrets(connection, profile.id, options),
									fetch: options.fetch,
								});
								const generated = await generateReply(connection, {
									conversationId: params.id,
									modelClient: client,
									connection: {
										profileId: profile.id,
										settingsRevision: connectionSettings.revision,
										backend: "ai-sdk",
										adapter: profile.adapter,
									},
									signal: request.signal,
									onEvent: (event) => emit("generation", event),
								});
								emit("complete", toGenerationPayload(generated));
							} catch (error) {
								if (error instanceof ModelClientGenerationError || error instanceof ModelClientTransportError) {
									emit("error", { outcome: "failed", reason: error.message });
								} else if (error instanceof ConversationNotPlayableError) {
									emit("error", { outcome: "not-playable", reason: error.message });
								} else if (error instanceof Error) {
									emit("error", { outcome: "invalid", reason: error.message });
								} else {
									emit("error", { outcome: "failed", reason: "Generation could not be completed." });
								}
							} finally {
								try { controller.close(); } catch { /* disconnected client */ }
							}
						});
					},
				});
				return new Response(stream, {
					headers: {
						"content-type": "text/event-stream; charset=utf-8",
						"cache-control": "no-cache, no-transform",
						connection: "keep-alive",
					},
				});
			},
			{
				params: t.Object({ id: t.Numeric() }),
				body: t.Object({}),
				response: t.Any(),
			},
		)
		.post(
			"/api/conversations/:id/commands",
			({ params, body, status }) => {
				try {
					// SAFETY: Elysia validates the discriminated command shape at this
					// boundary; the Conversation domain then validates generation values
					// before persistence and keeps the action vocabulary closed.
					const action = body.action as ConversationAction;
					const conversation = withDatabase(database, (connection) =>
						createConversationModule(connection).execute({
							conversationId: params.id,
							expectedRevision: body.expectedRevision,
							action,
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

function connectionSettingsModuleSecrets(
	database: Database,
	profileId: number,
	options: ConnectionSettingsModuleOptions,
) {
	return createConnectionSettingsModule(database, options).getProfileSecrets(profileId);
}

function toGenerationSettingsPayload(
	settings: ConversationGenerationSettings,
) {
	return {
		modelId: settings.modelId,
		temperature: settings.temperature,
		topP: settings.topP,
		frequencyPenalty: settings.frequencyPenalty,
		presencePenalty: settings.presencePenalty,
		contextLimit: settings.contextLimit,
		responseBudget: settings.responseBudget,
		requestOverrides: {
			"chat-completions": { ...settings.requestOverrides["chat-completions"] },
			responses: { ...settings.requestOverrides.responses },
			"anthropic-messages": { ...settings.requestOverrides["anthropic-messages"] },
		},
	};
}

function toGenerationPayload(snapshot: ConversationSnapshot) {
	const message = snapshot.messages.at(-1);
	const variant = message?.variants.at(-1);
	if (message === undefined || variant === undefined) {
		throw new Error("Generation completed without a persisted Variant.");
	}
	return {
		outcome: "applied" as const,
		conversation: toConversationSummary(snapshot),
		variant: {
			messageId: message.id,
			variantId: variant.id,
			content: variant.content,
			timestamp: variant.timestamp,
			data: variant.data.map((entry) => ({ ...entry })),
		},
	};
}
