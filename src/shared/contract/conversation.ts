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
	SiblingVariantUnavailableError,
	InvalidConversationCommandError,
	ParticipantNotFoundError,
	ParticipantNotRemovableError,
	createConversationModule,
	checkpointConversationTailGeneration,
	checkpointConversationSiblingGeneration,
	removeRetainedGenerationInspection,
	stopConversationGeneration,
	StaleConversationRevisionError,
	type ConversationAction,
	type ConversationGenerationSettings,
} from "../../server/conversation";
import {
	createConnectionSettingsModule,
	type ConnectionSettingsModuleOptions,
} from "../../server/connection-settings";
import {
	createModelClient,
	type ModelFetch,
} from "../../server/model-client";
import { openDatabase, withDatabase } from "../../server/database/database";
import {
	addCharacterToCast,
	startServerOwnedSendGeneration,
	startServerOwnedContinuationGeneration,
	startServerOwnedSiblingGeneration,
	generationRuntimeFor,
	defaultGenerationRuntime,
	type GenerationRuntimeState,
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
	continuationBody,
	conversationSummary,
	activeGenerationDetails,
	variantDetails,
	generationBody,
	invalidOutcome,
	notFoundOutcome,
	notPlayableOutcome,
	notRemovableOutcome,
	staleConversationConflict,
	toConversationSummary,
} from "./conversation-schema";

type GenerationRuntimeValue = ReturnType<ReturnType<typeof generationRuntimeFor>["get"]>;

const runtimeRegistryForRequest = (connection: Database, configuredDatabase: Database | undefined) =>
	configuredDatabase === undefined ? defaultGenerationRuntime() : generationRuntimeFor(connection);

const retainedInspectionCleanup = (
	configuredDatabase: Database | undefined,
	generationId: number,
) => () => withDatabase(configuredDatabase, (connection) =>
	removeRetainedGenerationInspection(connection, generationId));

const activeGenerationPayload = (state: GenerationRuntimeState) => ({
	outcome: "active-state" as const,
	generationId: state.generationId,
	conversationId: state.conversationId,
	messageId: state.messageId,
	variantId: state.variantId,
	content: state.content,
	reasoning: state.reasoning,
	latestEventId: state.latestEventId,
	status: state.status,
	terminalReason: state.terminalReason,
});

const terminalGenerationFrame = (state: GenerationRuntimeState) =>
	state.status === "complete"
		? {
			type: "complete",
			data: {
				outcome: "applied" as const,
				generationId: state.generationId,
				latestEventId: state.latestEventId,
			},
		}
		: state.status === "stopped"
			? {
				type: "stopped",
				data: { outcome: "stopped" as const, generationId: state.generationId },
			}
			: {
				type: "error",
				data: { outcome: "failed" as const, reason: state.terminalReason ?? "Generation failed." },
			};

function createGenerationSubscriptionResponse(
	runtime: NonNullable<GenerationRuntimeValue>,
	afterEventId: number,
	request: Request,
	onClosed?: () => void,
): Response {
	const encoder = new TextEncoder();
	const frame = (type: string, data: GenerationSsePayload, eventId?: number) =>
		`${eventId === undefined ? "" : `id: ${eventId}\n`}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			let subscription: ReturnType<typeof runtime.subscribe> | undefined;
			let removeStateListener: (() => void) | undefined;
			const emit = (type: string, data: GenerationSsePayload, eventId?: number) => {
				if (closed) return;
				try { controller.enqueue(encoder.encode(frame(type, data, eventId))); } catch { /* client disconnected */ }
			};
			const finish = (state: GenerationRuntimeState) => {
				if (closed || state.status === "active") return;
				subscription?.close();
				removeStateListener?.();
				const terminal = terminalGenerationFrame(state);
				emit(terminal.type, terminal.data);
				closed = true;
				try { controller.close(); } catch { /* client disconnected */ }
				onClosed?.();
			};
			subscription = runtime.subscribe(
				afterEventId,
				(envelope) => emit("generation", envelope.event, envelope.eventId),
				(state) => emit("state", activeGenerationPayload(state)),
			);
			removeStateListener = runtime.onStateChange(finish);
			finish(runtime.state);
			request.signal.addEventListener("abort", () => {
				if (closed) return;
				closed = true;
				subscription?.close();
				removeStateListener?.();
				onClosed?.();
			}, { once: true });
		},
	});
	return new Response(stream, {
		headers: {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive",
		},
	});
}

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
	| { readonly outcome: "applied"; readonly generationId?: number; readonly latestEventId?: number }
	| { readonly outcome: "failed"; readonly reason: string }
	| { readonly outcome: "stopped"; readonly generationId: number }
	| {
			readonly outcome: "active-state";
			readonly generationId: number;
			readonly conversationId: number;
			readonly messageId: number;
			readonly variantId: number;
			readonly content: string;
			readonly reasoning: string;
			readonly latestEventId: number;
			readonly status: "active" | "complete" | "stopped" | "failed";
			readonly terminalReason: string | null;
		};

export const createConversationRoutes = (
	database: Database | undefined,
	options: ConversationRouteOptions = {},
) =>
	new Elysia()
		.post(
			"/api/conversations/:id/generations/:generationId/stop",
			({ params, status }) => {
				const connection = database ?? openDatabase();
				let runtime: GenerationRuntimeValue;
				try {
					const registry = runtimeRegistryForRequest(connection, database);
					runtime = registry.get(params.generationId);
					if (runtime !== undefined && runtime.state.conversationId !== params.id) {
						return status(404, { outcome: "not-found" as const });
					}
					runtime?.stop();
					const conversation = stopConversationGeneration(connection, {
						conversationId: params.id,
						generationId: params.generationId,
					});
					runtime?.markStopped();
					return {
						outcome: "stopped" as const,
						generationId: params.generationId,
						conversation: toConversationSummary(conversation),
					};
				} catch (error) {
					if (error instanceof ConversationNotFoundError || error instanceof InvalidConversationCommandError) {
						runtime?.releaseStopRequest();
						return status(404, { outcome: "not-found" as const });
					}
					throw error;
				} finally {
					if (!database) connection.close();
				}
			},
			{
				params: t.Object({ id: t.Numeric(), generationId: t.Numeric() }),
				response: {
					200: t.Object({
						outcome: t.Literal("stopped"),
						generationId: t.Integer(),
						conversation: conversationSummary,
					}),
					404: notFoundOutcome,
				},
			},
		)
		.post(
			"/api/conversations/:id/generations/stop-all",
			({ params, status }) => {
				const connection = database ?? openDatabase();
				try {
					const conversationModule = createConversationModule(connection);
					const current = conversationModule.getSnapshot(params.id);
					if (current === undefined) return status(404, { outcome: "not-found" as const });
					const generationIds = current.activeGenerations.map((entry) => entry.generationId);
					if (generationIds.length === 0) return status(404, { outcome: "not-found" as const });
					const registry = runtimeRegistryForRequest(connection, database);
					const stoppedIds: number[] = [];
					let latest = current;
					for (const generationId of generationIds) {
						const runtime = registry.get(generationId);
						const matchingRuntime = runtime?.state.conversationId === params.id ? runtime : undefined;
						matchingRuntime?.stop();
						try {
							latest = stopConversationGeneration(connection, {
								conversationId: params.id,
								generationId,
							});
							stoppedIds.push(generationId);
							matchingRuntime?.markStopped();
						} catch (error) {
							if (!(error instanceof InvalidConversationCommandError)) throw error;
							matchingRuntime?.releaseStopRequest();
						}
					}
					if (stoppedIds.length === 0) return status(404, { outcome: "not-found" as const });
					return {
						outcome: "stopped" as const,
						generationIds: stoppedIds,
						conversation: toConversationSummary(latest),
					};
				} finally {
					if (!database) connection.close();
				}
			},
			{
				params: t.Object({ id: t.Numeric() }),
				response: {
					200: t.Object({
						outcome: t.Literal("stopped"),
						generationIds: t.Array(t.Integer()),
						conversation: conversationSummary,
					}),
					404: notFoundOutcome,
				},
			},
		)
		.post(
			"/api/conversations/:id/continue/generations",
			async ({ params, body, status }) => {
				const connection = database ?? openDatabase();
				try {
					const current = createConversationModule(connection).getSnapshot(params.id);
					if (current === undefined) {
						if (!database) connection.close();
						return status(404, { outcome: "not-found" as const });
					}
					const connectionSettings = createConnectionSettingsModule(connection, options).get();
					if (connectionSettings.activeProfileId === null) {
						if (!database) connection.close();
						return status(422, { outcome: "invalid" as const, reason: "An active Connection Profile is required for Generation." });
					}
					const profile = connectionSettings.profiles.find((entry) => entry.id === connectionSettings.activeProfileId);
					if (profile === undefined) {
						if (!database) connection.close();
						return status(422, { outcome: "invalid" as const, reason: "The active Connection Profile is unavailable." });
					}
					const runtimeRegistry = runtimeRegistryForRequest(connection, database);
					let runtime: ReturnType<typeof runtimeRegistry.start> | undefined;
					const started = startServerOwnedContinuationGeneration(connection, {
						conversationId: params.id,
						expectedRevision: body.expectedRevision,
						modelClient: createModelClient({
							profile,
							secrets: connectionSettingsModuleSecrets(connection, profile.id, options),
							fetch: options.fetch,
						}),
						connection: {
							profileId: profile.id,
							settingsRevision: connectionSettings.revision,
							backend: "ai-sdk",
							adapter: profile.adapter,
						},
					}, {
						onAccepted: (accepted, control) => {
							runtime = runtimeRegistry.start({
								generationId: accepted.generationId,
								conversationId: params.id,
								messageId: accepted.modelMessageId,
								variantId: accepted.provisionalVariantId,
								startedAt: new Date().toISOString(),
								onStop: control.stop,
								onRetentionExpired: retainedInspectionCleanup(database, accepted.generationId),
								onCheckpoint: ({ content: checkpointContent, reasoning, latestEventId }) =>
									checkpointConversationTailGeneration(connection, {
										conversationId: params.id,
										generationId: accepted.generationId,
										content: checkpointContent,
										reasoning,
										latestEventId,
									}),
							});
						},
						onEvent: (event) => { runtime?.publish(event); },
					});
					const accepted = await started.accepted;
					if (runtime === undefined) throw new Error("Generation runtime could not be started.");
					void started.result
						.then(() => runtime?.complete())
						.catch((error) => runtime?.fail(error instanceof Error ? error.message : "Generation failed."))
						.finally(() => { if (!database) connection.close(); });
					return {
						outcome: "accepted" as const,
						generationId: accepted.generationId,
						conversationId: params.id,
						messageId: accepted.modelMessageId,
						variantId: accepted.provisionalVariantId,
					};
				} catch (error) {
					if (!database) connection.close();
					if (error instanceof ConversationNotPlayableError) return status(409, { outcome: "not-playable", reason: error.message });
					if (error instanceof StaleConversationRevisionError) return status(409, { outcome: "conflict", reason: error.message });
					if (error instanceof Error) return status(422, { outcome: "invalid", reason: error.message });
					return status(422, { outcome: "invalid", reason: "Continuation Generation could not be started." });
				}
			},
			{
				params: t.Object({ id: t.Numeric() }),
				body: continuationBody,
				response: {
					200: t.Object({
						outcome: t.Literal("accepted"),
						generationId: t.Integer(),
						conversationId: t.Integer(),
						messageId: t.Integer(),
						variantId: t.Integer(),
					}),
					404: notFoundOutcome,
					409: t.Union([
						t.Object({ outcome: t.Literal("conflict"), reason: t.String() }),
						notPlayableOutcome,
					]),
					422: invalidOutcome,
				},
			},
		)
		.get(
			"/api/conversations/:id/generations/:generationId/inspection",
			({ params, status }) => {
				const details = withDatabase(database, (connection) =>
					createConversationModule(connection).readActiveGenerationDetails(
						params.id,
						params.generationId,
					),
				);
				if (details === undefined) return status(404, { outcome: "not-found" as const });
				return details;
			},
			{
				params: t.Object({ id: t.Numeric(), generationId: t.Numeric() }),
				response: { 200: activeGenerationDetails, 404: notFoundOutcome },
			},
		)
		// Details is a vocabulary-friendly alias used by Message/Generation
		// panels; both paths share the same bounded read semantics.
		.get(
			"/api/conversations/:id/generations/:generationId/details",
			({ params, status }) => {
				const details = withDatabase(database, (connection) =>
					createConversationModule(connection).readActiveGenerationDetails(
						params.id,
						params.generationId,
					),
				);
				if (details === undefined) return status(404, { outcome: "not-found" as const });
				return details;
			},
			{
				params: t.Object({ id: t.Numeric(), generationId: t.Numeric() }),
				response: { 200: activeGenerationDetails, 404: notFoundOutcome },
			},
		)
		.get(
			"/api/conversations/:id/messages/:messageId/variants/:variantId/details",
			({ params, status }) => {
				const details = withDatabase(database, (connection) =>
					createConversationModule(connection).readVariantDetails(
						params.id,
						params.messageId,
						params.variantId,
					),
				);
				if (details === undefined) return status(404, { outcome: "not-found" as const });
				return details;
			},
			{
				params: t.Object({ id: t.Numeric(), messageId: t.Numeric(), variantId: t.Numeric() }),
				response: { 200: variantDetails, 404: notFoundOutcome },
			},
		)
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
			"/api/conversations/:id/generations",
			async ({ params, body, status }) => {
				if (body.expectedRevision === undefined || body.content === undefined) {
					return status(422, { outcome: "invalid", reason: "Generation start requires content and an expected Conversation revision." });
				}
				const connection = database ?? openDatabase();
				try {
					const current = createConversationModule(connection).getSnapshot(params.id);
					if (current === undefined) {
						if (!database) connection.close();
						return status(404, { outcome: "not-found" as const });
					}
					const connectionSettings = createConnectionSettingsModule(connection, options).get();
					if (connectionSettings.activeProfileId === null) {
						if (!database) connection.close();
						return status(422, { outcome: "invalid", reason: "An active Connection Profile is required for Generation." });
					}
					const profile = connectionSettings.profiles.find((entry) => entry.id === connectionSettings.activeProfileId);
					if (profile === undefined) {
						if (!database) connection.close();
						return status(422, { outcome: "invalid", reason: "The active Connection Profile is unavailable." });
					}
					const runtimeRegistry = runtimeRegistryForRequest(connection, database);
					let runtime: ReturnType<typeof runtimeRegistry.start> | undefined;
					const started = startServerOwnedSendGeneration(connection, {
						conversationId: params.id,
						modelClient: createModelClient({
							profile,
							secrets: connectionSettingsModuleSecrets(connection, profile.id, options),
							fetch: options.fetch,
						}),
						connection: {
							profileId: profile.id,
							settingsRevision: connectionSettings.revision,
							backend: "ai-sdk",
							adapter: profile.adapter,
						},
						expectedRevision: body.expectedRevision,
						content: body.content,
					}, {
						onAccepted: (accepted, control) => {
							runtime = runtimeRegistry.start({
								generationId: accepted.generationId,
								conversationId: params.id,
								messageId: accepted.modelMessageId,
								variantId: accepted.provisionalVariantId,
								startedAt: new Date().toISOString(),
								onStop: control.stop,
								onRetentionExpired: retainedInspectionCleanup(database, accepted.generationId),
								onCheckpoint: ({ content: checkpointContent, reasoning, latestEventId }) => checkpointConversationTailGeneration(connection, {
									conversationId: params.id,
									generationId: accepted.generationId,
									content: checkpointContent,
									reasoning,
									latestEventId,
								}),
							});
						},
						onEvent: (event) => { runtime?.publish(event); },
					});
					const accepted = await started.accepted;
					if (runtime === undefined) throw new Error("Generation runtime could not be started.");
					void started.result
						.then(() => runtime?.complete())
						.catch((error) => runtime?.fail(error instanceof Error ? error.message : "Generation failed."))
						.finally(() => { if (!database) connection.close(); });
					return {
						outcome: "accepted" as const,
						generationId: accepted.generationId,
						conversationId: params.id,
						messageId: accepted.modelMessageId,
						variantId: accepted.provisionalVariantId,
					};
				} catch (error) {
					if (!database) connection.close();
					if (error instanceof ConversationNotPlayableError) return status(409, { outcome: "not-playable", reason: error.message });
					if (error instanceof StaleConversationRevisionError) return status(409, { outcome: "conflict", reason: error.message });
					if (error instanceof Error) return status(422, { outcome: "invalid", reason: error.message });
					return status(422, { outcome: "invalid", reason: "Generation could not be started." });
				}
			},
			{
				params: t.Object({ id: t.Numeric() }),
				body: generationBody,
				response: {
					200: t.Object({
						outcome: t.Literal("accepted"),
						generationId: t.Integer(),
						conversationId: t.Integer(),
						messageId: t.Integer(),
						variantId: t.Integer(),
					}),
					404: notFoundOutcome,
					409: t.Union([
						t.Object({ outcome: t.Literal("conflict"), reason: t.String() }),
						notPlayableOutcome,
					]),
					422: invalidOutcome,
				},
			},
		)
		.get(
			"/api/conversations/:id/generations/:generationId/events",
			({ params, query, request }) => {
				const connection = database ?? openDatabase();
				const runtime = runtimeRegistryForRequest(connection, database).get(params.generationId);
				if (runtime === undefined || runtime.state.conversationId !== params.id) {
					if (!database) connection.close();
					return new Response(JSON.stringify({ outcome: "not-found" }), {
						status: 404,
						headers: { "content-type": "application/json" },
					});
				}
				return createGenerationSubscriptionResponse(
					runtime,
					query.after ?? 0,
					request,
					() => { if (!database) connection.close(); },
				);
			},
			{
				params: t.Object({ id: t.Numeric(), generationId: t.Numeric() }),
				query: t.Object({ after: t.Optional(t.Numeric()) }),
				response: t.Any(),
			},
		)
                // A targeted Swipe creates one server-owned Provisional Variant
                // on an existing Message. The request is only an observer;
                // closing it never aborts the sibling provider attempt.
                .post(
                        "/api/conversations/:id/messages/:messageId/sibling/generations",
                        async ({ params, status }) => {
                                const connection = database ?? openDatabase();
                                try {
                                        const current = createConversationModule(connection).getSnapshot(params.id);
                                        if (current === undefined) {
                                                if (!database) connection.close();
                                                return status(404, { outcome: "not-found" as const });
                                        }
                                        const connectionSettings = createConnectionSettingsModule(connection, options).get();
                                        if (connectionSettings.activeProfileId === null) {
                                                if (!database) connection.close();
                                                return status(422, { outcome: "invalid" as const, reason: "An active Connection Profile is required for Generation." });
                                        }
                                        const profile = connectionSettings.profiles.find((entry) => entry.id === connectionSettings.activeProfileId);
                                        if (profile === undefined) {
                                                if (!database) connection.close();
                                                return status(422, { outcome: "invalid" as const, reason: "The active Connection Profile is unavailable." });
                                        }
                                        const registry = runtimeRegistryForRequest(connection, database);
										let runtime: ReturnType<typeof registry.start> | undefined;
										const started = startServerOwnedSiblingGeneration(connection, {
                                                conversationId: params.id,
                                                messageId: params.messageId,
                                                modelClient: createModelClient({
                                                        profile,
                                                        secrets: connectionSettingsModuleSecrets(connection, profile.id, options),
                                                        fetch: options.fetch,
                                                }),
                                                connection: {
                                                        profileId: profile.id,
                                                        settingsRevision: connectionSettings.revision,
                                                        backend: "ai-sdk",
                                                        adapter: profile.adapter,
                                                },
                                        }, {
                                                onAccepted: (accepted, control) => {
                                                        runtime = registry.start({
                                                                generationId: accepted.generationId,
                                                                conversationId: params.id,
                                                                messageId: accepted.messageId,
                                                                variantId: accepted.provisionalVariantId,
                                                                startedAt: new Date().toISOString(),
												onStop: control.stop,
												onRetentionExpired: retainedInspectionCleanup(database, accepted.generationId),
													onCheckpoint: ({ content: checkpointContent, reasoning, latestEventId }) => checkpointConversationSiblingGeneration(connection, {
														conversationId: params.id,
														generationId: accepted.generationId,
														content: checkpointContent,
														reasoning,
														latestEventId,
													}),
                                                        });
                                                },
                                                onEvent: (event) => { runtime?.publish(event); },
                                        });
                                        const accepted = await started.accepted;
                                        if (runtime === undefined) throw new Error("Generation runtime could not be started.");
                                        void started.result
                                                .then(() => runtime?.complete())
                                                .catch((error) => runtime?.fail(error instanceof Error ? error.message : "Generation failed."))
                                                .finally(() => { if (!database) connection.close(); });
                                        return {
                                                outcome: "accepted" as const,
                                                generationId: accepted.generationId,
                                                conversationId: params.id,
                                                messageId: accepted.messageId,
                                                variantId: accepted.provisionalVariantId,
                                        };
                                } catch (error) {
                                        if (!database) connection.close();
                                        if (error instanceof ConversationNotPlayableError) {
                                                return status(409, { outcome: "not-playable" as const, reason: error.message });
                                        }
                                        if (error instanceof SiblingVariantUnavailableError || error instanceof Error) {
                                                return status(422, { outcome: "invalid" as const, reason: error.message });
                                        }
                                        return status(422, { outcome: "invalid" as const, reason: "Sibling Generation could not be started." });
                                }
                        },
                        {
                                params: t.Object({ id: t.Numeric(), messageId: t.Numeric() }),
                                response: {
                                        200: t.Object({
                                                outcome: t.Literal("accepted"),
                                                generationId: t.Integer(),
                                                conversationId: t.Integer(),
                                                messageId: t.Integer(),
                                                variantId: t.Integer(),
                                        }),
                                        404: notFoundOutcome,
                                        409: notPlayableOutcome,
                                        422: invalidOutcome,
                                },
                        },
                )
                // Revisioned Conversation commands remain separate from the
                // server-owned Generation acceptance and event routes above.
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
				safetyAllowance: settings.safetyAllowance,
				siblingGenerationLimit: settings.siblingGenerationLimit,
				continuationStrategy: settings.continuationStrategy,
				continuationInstruction: settings.continuationInstruction,
				continuationPrefillSuffix: settings.continuationPrefillSuffix,
		requestOverrides: {
			"chat-completions": { ...settings.requestOverrides["chat-completions"] },
			responses: { ...settings.requestOverrides.responses },
			"anthropic-messages": { ...settings.requestOverrides["anthropic-messages"] },
		},
	};
}
