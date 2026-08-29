import type { Database } from "bun:sqlite";
import { openDatabase, withDatabase } from "../database/database";
import {
	checkpointConversationSiblingGeneration,
	checkpointConversationTailGeneration,
	ConversationNotFoundError,
	createConversationModule,
	removeRetainedGenerationInspection,
	type AcceptedContinuationGeneration,
	type AcceptedSiblingGeneration,
	type AcceptedTailGeneration,
} from "../conversation";
import {
	createConnectionSettingsModule,
	type ConnectionSettingsModuleOptions,
} from "../connection-settings";
import {
	createModelClient,
	type ModelClient,
	type ModelClientConnectionSnapshot,
	type ModelClientEvent,
	type ModelFetch,
} from "../model-client";
import {
	defaultGenerationRuntime,
	generationRuntimeFor,
	type GenerationRuntime,
	type GenerationRuntimeRegistry,
} from "../workflows";
import {
	startServerOwnedContinuationGeneration,
	startServerOwnedSendGeneration,
	startServerOwnedSiblingGeneration,
	type ContinueGenerationInput,
	type ServerOwnedGenerationControl,
	type SendThroughProvisionalTailGenerationInput,
	type GenerateSiblingVariantInput,
	type ContinueGenerationResult,
	type SendThroughProvisionalTailGenerationResult,
	type SiblingGenerationResult,
} from "../workflows";

/** Dependencies needed by the HTTP/application generation adapter. */
export interface GenerationCoordinatorOptions extends ConnectionSettingsModuleOptions {
	readonly fetch?: ModelFetch;
}

/** A configured transport prerequisite that the Generation HTTP contract can report as invalid. */
export class GenerationConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GenerationConfigurationError";
	}
}

export interface CoordinatedGeneration<TAccepted, TResult> {
	/** The authoritative acceptance returned after the provisional target exists. */
	readonly accepted: TAccepted;
	/** The process-local runtime that fans out events to observers. */
	readonly runtime: GenerationRuntime;
	/** Settles after terminal Conversation state has been committed. */
	readonly result: Promise<TResult>;
}

type GenerationAccepted =
	| AcceptedTailGeneration
	| AcceptedContinuationGeneration
	| AcceptedSiblingGeneration;

type GenerationResult =
	| SendThroughProvisionalTailGenerationResult
	| ContinueGenerationResult
	| SiblingGenerationResult;

interface GenerationStartCallbacks<TAccepted extends GenerationAccepted> {
	onAccepted: (
		accepted: TAccepted,
		control: ServerOwnedGenerationControl,
	) => void | Promise<void>;
	onEvent: (event: ModelClientEvent) => void | Promise<void>;
}

interface GenerationStartContext<TAccepted extends GenerationAccepted> {
	database: Database;
	modelClient: ModelClient;
	connection: ModelClientConnectionSnapshot;
	onBeforeTerminal: () => void;
	callbacks: GenerationStartCallbacks<TAccepted>;
}

interface ManagedGenerationInput<TAccepted extends GenerationAccepted, TResult> {
	conversationId: number;
	start: (
		context: GenerationStartContext<TAccepted>,
	) => ServerOwnedGenerationHandle<TAccepted, TResult>;
	runtimeTarget: (accepted: TAccepted) => {
		messageId: number;
		variantId: number;
	};
	checkpoint: (
		database: Database,
		accepted: TAccepted,
		output: GenerationCheckpoint,
	) => void;
}

interface ServerOwnedGenerationHandle<TAccepted, TResult> {
	readonly accepted: Promise<TAccepted>;
	readonly result: Promise<TResult>;
}

interface GenerationCheckpoint {
	readonly content: string;
	readonly reasoning: string;
	readonly latestEventId: number;
}

interface ResolvedGenerationTransport {
	readonly modelClient: ModelClient;
	readonly connection: ModelClientConnectionSnapshot;
}

/**
 * Coordinates the application concerns around one server-owned Generation.
 *
 * The workflow module owns prompt capture and Conversation lifecycle rules;
 * this seam owns the concerns specific to an HTTP-started attempt: resolving
 * the active Profile, constructing its Model Client, attaching the process
 * runtime, checkpointing output, retaining inspection state, and closing a
 * short-lived request database after terminal work.
 */
export class GenerationCoordinator {
	constructor(
		private readonly configuredDatabase: Database | undefined,
		private readonly options: GenerationCoordinatorOptions = {},
	) {}

	startSendGeneration(
		input: Omit<SendThroughProvisionalTailGenerationInput, "modelClient" | "connection" | "connectionSettings" | "signal" | "onEvent" | "onBeforeTerminal" | "onAccepted">,
	): Promise<CoordinatedGeneration<AcceptedTailGeneration, SendThroughProvisionalTailGenerationResult>> {
		return this.startGeneration({
			conversationId: input.conversationId,
			start: ({ database, modelClient, connection, onBeforeTerminal, callbacks }) =>
				startServerOwnedSendGeneration(database, {
					...input,
					modelClient,
					connection,
					onBeforeTerminal,
				}, callbacks),
			runtimeTarget: (accepted) => ({
				messageId: accepted.modelMessageId,
				variantId: accepted.provisionalVariantId,
			}),
			checkpoint: (database, accepted, output) => checkpointConversationTailGeneration(database, {
				conversationId: input.conversationId,
				generationId: accepted.generationId,
				...output,
			}),
		});
	}

	startContinuationGeneration(
		input: Omit<ContinueGenerationInput, "modelClient" | "connection" | "connectionSettings" | "signal" | "onEvent" | "onBeforeTerminal" | "onAccepted">,
	): Promise<CoordinatedGeneration<AcceptedContinuationGeneration, ContinueGenerationResult>> {
		return this.startGeneration({
			conversationId: input.conversationId,
			start: ({ database, modelClient, connection, onBeforeTerminal, callbacks }) =>
				startServerOwnedContinuationGeneration(database, {
					...input,
					modelClient,
					connection,
					onBeforeTerminal,
				}, callbacks),
			runtimeTarget: (accepted) => ({
				messageId: accepted.modelMessageId,
				variantId: accepted.provisionalVariantId,
			}),
			checkpoint: (database, accepted, output) => checkpointConversationTailGeneration(database, {
				conversationId: input.conversationId,
				generationId: accepted.generationId,
				...output,
			}),
		});
	}

	startSiblingGeneration(
		input: Omit<GenerateSiblingVariantInput, "modelClient" | "connection" | "connectionSettings" | "signal" | "onEvent" | "onBeforeTerminal" | "onAccepted">,
	): Promise<CoordinatedGeneration<AcceptedSiblingGeneration, SiblingGenerationResult>> {
		return this.startGeneration({
			conversationId: input.conversationId,
			start: ({ database, modelClient, connection, onBeforeTerminal, callbacks }) =>
				startServerOwnedSiblingGeneration(database, {
					...input,
					modelClient,
					connection,
					onBeforeTerminal,
				}, callbacks),
			runtimeTarget: (accepted) => ({
				messageId: accepted.messageId,
				variantId: accepted.provisionalVariantId,
			}),
			checkpoint: (database, accepted, output) => checkpointConversationSiblingGeneration(database, {
				conversationId: input.conversationId,
				generationId: accepted.generationId,
				...output,
			}),
		});
	}

	private async startGeneration<
		TAccepted extends GenerationAccepted,
		TResult extends GenerationResult,
	>(
		input: ManagedGenerationInput<TAccepted, TResult>,
	): Promise<CoordinatedGeneration<TAccepted, TResult>> {
		const database = this.openDatabase();
		let closed = false;
		const close = () => {
			if (closed || this.configuredDatabase !== undefined) return;
			closed = true;
			database.close();
		};

		try {
			if (!createConversationModule(database).exists(input.conversationId)) {
				throw new ConversationNotFoundError(input.conversationId);
			}
			const transport = this.resolveTransport(database);
			const runtimeRegistry = this.runtimeRegistry(database);
			let runtime: GenerationRuntime | undefined;
			const started = input.start({
				database,
				modelClient: transport.modelClient,
				connection: transport.connection,
				onBeforeTerminal: () => runtime?.flushCheckpoint(),
				callbacks: {
					onAccepted: (accepted, control) => {
						const target = input.runtimeTarget(accepted);
						runtime = runtimeRegistry.start({
							generationId: accepted.generationId,
							conversationId: input.conversationId,
							messageId: target.messageId,
							variantId: target.variantId,
							startedAt: new Date().toISOString(),
							onStop: control.stop,
							onRetentionExpired: retainedInspectionCleanup(
								this.configuredDatabase,
								accepted.generationId,
							),
							onCheckpoint: (output) => input.checkpoint(database, accepted, output),
						});
					},
					onEvent: (event) => { runtime?.publish(event); },
				},
			});
			const accepted = await started.accepted;
			if (runtime === undefined) throw new Error("Generation runtime could not be started.");
			const activeRuntime = runtime;
			const result = started.result
				.then((value) => {
					activeRuntime.complete();
					return value;
				})
				.catch((error) => {
					activeRuntime.fail(error instanceof Error ? error.message : "Generation failed.");
					throw error;
				})
				.finally(close);
			// The HTTP adapter intentionally returns after acceptance. Consume the
			// detached rejection here while exposing the terminal Promise to tests
			// and non-HTTP callers that want to await it.
			void result.catch(() => undefined);
			return { accepted, runtime: activeRuntime, result };
		} catch (error) {
			close();
			throw error;
		}
	}

	private openDatabase(): Database {
		return this.configuredDatabase ?? openDatabase();
	}

	private runtimeRegistry(database: Database): GenerationRuntimeRegistry {
		return this.configuredDatabase === undefined
			? defaultGenerationRuntime()
			: generationRuntimeFor(database);
	}

	private resolveTransport(database: Database): ResolvedGenerationTransport {
		const settingsModule = createConnectionSettingsModule(database, this.options);
		const settings = settingsModule.get();
		if (settings.activeProfileId === null) {
			throw new GenerationConfigurationError("An active Connection Profile is required for Generation.");
		}
		const profile = settings.profiles.find((entry) => entry.id === settings.activeProfileId);
		if (profile === undefined) {
			throw new GenerationConfigurationError("The active Connection Profile is unavailable.");
		}
		return {
			modelClient: createModelClient({
				profile,
				secrets: settingsModule.getProfileSecrets(profile.id),
				fetch: this.options.fetch,
			}),
			connection: {
				profileId: profile.id,
				settingsRevision: settings.revision,
				backend: "ai-sdk",
				adapter: profile.adapter,
			},
		};
	}
}

export function createGenerationCoordinator(
	database: Database | undefined,
	options: GenerationCoordinatorOptions = {},
): GenerationCoordinator {
	return new GenerationCoordinator(database, options);
}

const retainedInspectionCleanup = (
	configuredDatabase: Database | undefined,
	generationId: number,
) => () => withDatabase(configuredDatabase, (database) =>
	removeRetainedGenerationInspection(database, generationId));
