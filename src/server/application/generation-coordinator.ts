import type { Database } from "bun:sqlite";
import {
	checkpointConversationGeneration,
	ConversationNotFoundError,
	InvalidConversationCommandError,
	createConversationModule,
	removeRetainedGenerationInspection,
	type ConversationSummary,
} from "../conversation";
import {
	connectionSnapshotOf,
	createConnectionSettingsModule,
	type ConnectionSettingsModuleOptions,
} from "../connection-settings";
import { imageLoader } from "../image";
import {
	createModelClient,
	ModelClientGenerationError,
	type ModelClient,
	type ModelClientConnectionSnapshot,
	type ModelClientGenerationInput,
	type ModelClientEvent,
	type ModelFetch,
} from "../model-client";
import {
	generationRuntimeFor,
	startServerOwnedGeneration,
	type AcceptedGenerationRecord,
	type GenerationStartInput,
	type GenerationRuntime,
	type ServerOwnedGeneration,
	type ServerOwnedGenerationControl,
} from "../workflows";
import type { GenerationCheckpointOptions } from "../workflows/generation-runtime";

/** ==[HUMAN APPROVED]== Dependencies needed by the HTTP/application generation adapter. */
export interface GenerationCoordinatorOptions extends ConnectionSettingsModuleOptions {
	readonly fetch?: ModelFetch;
	readonly checkpoint?: GenerationCheckpointOptions;
}

/**
 * ==[HUMAN APPROVED]== Typed application outcome of stopping one server-owned Generation.
 *
 * The only distinction a caller can act on is whether the durable interrupted
 * transition committed. Everything that leaves nothing stopped — an unknown
 * target, a Conversation that is gone, a Generation owned by a different
 * Conversation, or a natural completion that won the race — is one
 * `not-stoppable` outcome; the coordinator still handles each internally,
 * releasing the losing Stop request so the provider's own terminal event
 * settles the runtime. These outcomes carry no HTTP terminology; transports
 * map them onto their own response vocabulary.
 */
export type GenerationStopOutcome =
	| {
			readonly outcome: "stopped";
			readonly generationId: number;
			readonly conversation: ConversationSummary;
			/**
			 * ==[HUMAN APPROVED]== Why the process runtime could not be settled, or null when it
			 * settled cleanly. Either way the durable transition committed and
			 * the Conversation snapshot is the authoritative result.
			 */
			readonly unsettledReason: string | null;
	  }
	| {
			readonly outcome: "not-stoppable";
			readonly generationId: number;
	  };

/** ==[HUMAN APPROVED]== Typed application outcome of stopping every Active Generation of one Conversation. */
export type GenerationStopAllOutcome =
	| {
			readonly outcome: "stopped";
			readonly generationIds: readonly number[];
			readonly conversation: ConversationSummary;
			/** ==[HUMAN APPROVED]== Generations whose durable transition committed but whose runtime lingers. */
			readonly unsettled: readonly number[];
			readonly unsettledReason: string | null;
	  }
	| {
			/** ==[HUMAN APPROVED]== The Conversation is unknown or has no Active Generations to stop. */
			readonly outcome: "not-stoppable";
	  };

/** ==[HUMAN APPROVED]== A configured transport prerequisite that the Generation HTTP contract can report as invalid. */
export class GenerationConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GenerationConfigurationError";
	}
}

export interface CoordinatedGeneration<TAccepted, TResult> {
	/** ==[HUMAN APPROVED]== The authoritative acceptance returned after the provisional target exists. */
	readonly accepted: TAccepted;
	/** ==[HUMAN APPROVED]== The process-local runtime that fans out events to observers. */
	readonly runtime: GenerationRuntime;
	/** ==[HUMAN APPROVED]== Settles after terminal Conversation state has been committed. */
	readonly result: Promise<TResult>;
}

/**
 * ==[HUMAN APPROVED]== What every accepted Generation tells the Coordinator: the Provisional
 * Variant and the Message it belongs to. Send additionally reports the human
 * Message it wrote and Sibling the previously selected Variant, but the
 * runtime target is the same question for all three, so this is a shape they
 * satisfy rather than a union that has to name them.
 */
interface AcceptedGeneration {
	readonly generationId: number;
	readonly messageId: number;
	readonly provisionalVariantId: number;
}

/**
 * ==[HUMAN APPROVED]== The attempt fields the Coordinator resolves itself: the transport it builds
 * from the Conversation-selected Profile, the detached signal and observers the runtime
 * owns, and the terminal checkpoint flush. A caller supplies only the rest. The omission
 * distributes so a union start input keeps its per-kind fields.
 */
export type GenerationStartRequest<TInput> = TInput extends unknown ? Omit<
	TInput,
	| "modelClient"
	| "connection"
	| "connectionSettings"
	| "signal"
	| "onEvent"
	| "onBeforeTerminal"
	| "onAccepted"
> : never;

interface GenerationStartCallbacks<TAccepted extends AcceptedGeneration> {
	onAccepted: (
		accepted: TAccepted,
		control: ServerOwnedGenerationControl,
	) => void | Promise<void>;
	onEvent: (event: ModelClientEvent) => void | Promise<void>;
}

interface GenerationStartContext<TAccepted extends AcceptedGeneration> {
	database: Database;
	modelClient: ModelClient;
	connection: ModelClientConnectionSnapshot;
	onBeforeTerminal: () => void;
	callbacks: GenerationStartCallbacks<TAccepted>;
}

interface ManagedGenerationInput<TAccepted extends AcceptedGeneration, TResult> {
	conversationId: number;
	start: (
		context: GenerationStartContext<TAccepted>,
	) => ServerOwnedGeneration<TAccepted, TResult>;
}

interface ResolvedGenerationTransport {
	readonly modelClient: ModelClient;
	readonly connection: ModelClientConnectionSnapshot;
}

/**
 * ==[HUMAN APPROVED]== Coordinates the application concerns around one server-owned Generation.
 *
 * The workflow module owns prompt capture and Conversation lifecycle rules;
 * this seam owns the concerns specific to an HTTP-started attempt: resolving
 * the Conversation-selected Profile, constructing its Model Client, attaching the process
 * runtime, checkpointing output, retaining inspection state, and tracking work through application shutdown.
 */
export class GenerationCoordinator {
	constructor(
		private readonly database: Database,
		private readonly options: GenerationCoordinatorOptions = {},
	) {}

	/**
	 * ==[HUMAN APPROVED]== Start one server-owned Generation of any attempt kind. The attempt
	 * input's own fields select the lifecycle: Send carries the submitted text,
	 * Sibling the target Message, and Continue neither.
	 */
	startGeneration(
		input: GenerationStartRequest<GenerationStartInput>,
	): Promise<CoordinatedGeneration<AcceptedGenerationRecord, AcceptedGenerationRecord>> {
		return this.coordinate({
			conversationId: input.conversationId,
			start: ({ database, modelClient, connection, onBeforeTerminal, callbacks }) =>
				startServerOwnedGeneration(database, {
					...input,
					modelClient,
					connection,
					preparationFetch: this.options.fetch,
					connectionSettings: this.options,
					onBeforeTerminal,
				}, callbacks),
		});
	}

	/**
	 * ==[HUMAN APPROVED]== Stop one server-owned Generation: request provider cancellation with a
	 * forced final checkpoint, commit the durable interrupted transition, then
	 * settle the process runtime. The typed outcome is the only application
	 * result; transports map it onto their own response vocabulary.
	 */
	async stopGeneration(conversationId: number, generationId: number): Promise<GenerationStopOutcome> {
		const database = this.database;
		const runtimes = generationRuntimeFor(database);
		const runtime = runtimes.get(generationId);
		// @approved
		//  The runtime registry knows which Conversation owns this Generation.
		// A mismatch means the addressed Conversation has no such Generation;
		// durable state is never consulted under another Conversation's name.
		if (runtime !== undefined && runtime.state.conversationId !== conversationId) {
			return { outcome: "not-stoppable", generationId } as const;
		}
		// @approved
		//  A failed checkpoint must prevent a Stop from using stale output.
		runtime?.stop();
		const conversation = createConversationModule(database);
		try {
			const snapshot = conversation.stopGeneration({ conversationId, generationId });
			return this.settleStoppedGeneration(generationId, runtime, snapshot);
		} catch (error) {
			runtime?.releaseStopRequest();
			if (
				error instanceof InvalidConversationCommandError ||
				error instanceof ConversationNotFoundError
			) {
				// @approved
				//  Nothing durable was stopped: the Active Generation vanished
				// while this Stop was in flight (the natural-completion race),
				// or the Conversation is gone and the provider attempt cannot
				// durably commit either. Release the Stop request so the
				// runtime still settles through its own terminal path.
				return { outcome: "not-stoppable", generationId } as const;
			}
			throw error;
		}
	}

	/**
	 * ==[HUMAN APPROVED]== Stop every Active Generation of one Conversation: force checkpoints
	 * without aborting, commit the durable interrupted transition for the
	 * complete target set, and only then settle the corresponding runtimes.
	 * The Conversation stays authoritative during races: runtimes are settled
	 * exclusively for targets the durable transition actually committed.
	 */
	async stopAllGenerations(conversationId: number): Promise<GenerationStopAllOutcome> {
		const database = this.database;
		const runtimes = generationRuntimeFor(database);
		// @approved
		//  Forced checkpoints without aborting first. The durable transition
		// below owns the complete target set; runtimes are settled only after
		// its commit succeeds.
		runtimes.flushAll(conversationId);
		const conversation = createConversationModule(database);
		try {
			const stopped = conversation.stopGenerations({ conversationId });
			const unsettled: number[] = [];
			let unsettledReason: string | null = null;
			for (const generationId of stopped.generationIds) {
				const runtime = runtimes.get(generationId);
				if (runtime?.state.conversationId !== conversationId) continue;
				try {
					runtime.stop();
					runtime.markStopped();
				} catch (error) {
					unsettled.push(generationId);
					unsettledReason ??= error instanceof Error
						? error.message
						: "The Generation runtime could not be settled.";
				}
			}
			return {
				outcome: "stopped",
				generationIds: stopped.generationIds,
				conversation: stopped.conversation,
				unsettled,
				unsettledReason,
			} as const;
		} catch (error) {
			if (
				error instanceof ConversationNotFoundError ||
				error instanceof InvalidConversationCommandError
			) {
				return { outcome: "not-stoppable" } as const;
			}
			throw error;
		}
	}

	private settleStoppedGeneration(
		generationId: number,
		runtime: GenerationRuntime | undefined,
		snapshot: ConversationSummary,
	): GenerationStopOutcome {
		let unsettledReason: string | null = null;
		if (runtime !== undefined) {
			try {
				runtime.markStopped();
			} catch (error) {
				unsettledReason = error instanceof Error
					? error.message
					: "The Generation runtime could not be settled.";
			}
		}
		return { outcome: "stopped", generationId, conversation: snapshot, unsettledReason };
	}

	private async coordinate<
		TAccepted extends AcceptedGeneration,
		TResult,
	>(
		input: ManagedGenerationInput<TAccepted, TResult>,
	): Promise<CoordinatedGeneration<TAccepted, TResult>> {
		const database = this.database;
		const runtimeRegistry = generationRuntimeFor(database);
		runtimeRegistry.assertAccepting();
		const generationSettings = createConversationModule(database).getGenerationSettings(input.conversationId);
		if (generationSettings === undefined) throw new ConversationNotFoundError(input.conversationId);
		const transport = this.resolveTransport(database, generationSettings.connectionProfileId);
		let runtime: GenerationRuntime | undefined;
		let capturedRequest: ModelClientGenerationInput | undefined;
		const started = input.start({
			database,
			modelClient: { generate: (request) => {
				capturedRequest = request;
				return transport.modelClient.generate(request);
			} },
			connection: transport.connection,
			onBeforeTerminal: () => {
				if (runtime?.isTerminal) throw new ModelClientGenerationError("cancelled", "Generation has already stopped.");
				runtime?.flushCheckpoint();
			},
			callbacks: {
				onAccepted: (accepted, control) => {
					runtime = runtimeRegistry.start({
						generationId: accepted.generationId,
						conversationId: input.conversationId,
						messageId: accepted.messageId,
						variantId: accepted.provisionalVariantId,
						startedAt: new Date().toISOString(),
						checkpoint: this.options.checkpoint,
						onStop: control.stop,
						onRetentionExpired: retainedInspectionCleanup(
							this.database,
							accepted.generationId,
						),
						onCheckpoint: (output) => checkpointConversationGeneration(database, {
								conversationId: input.conversationId,
								generationId: accepted.generationId,
								...output,
							}),
					});
				},
				onEvent: (event) => { runtime?.publish(event); },
			},
		});
		runtimeRegistry.track(started.result);
		const accepted = await started.accepted;
		if (runtime === undefined) throw new Error("Generation runtime could not be started.");
		const activeRuntime = runtime;
		const result = started.result
			.then((value) => {
				activeRuntime.complete();
				return value;
			})
			.catch((error) => {
				const kind = error instanceof ModelClientGenerationError ? error.kind : "transport";
				try {
					activeRuntime.fail({
						reason: error instanceof Error ? error.message : "Generation failed.",
						kind,
						responseBody: error instanceof ModelClientGenerationError ? error.responseBody : undefined,
						// ==[HUMAN APPROVED]== Protocol failures are local refusals raised before any request reaches the provider.
						imageModel: kind !== "cancelled" && kind !== "protocol" && capturedRequest?.promptPlan.images.some((image) => image.disposition === "send")
							? { connectionProfileId: transport.connection.profileId, modelId: capturedRequest.modelId }
							: undefined,
					});
				} catch {
					// @approved
					//  Keep uncheckpointed output in the active runtime for a later Stop.
				}
				throw error;
			});
		// @approved
		//  The HTTP adapter intentionally returns after acceptance. Consume the
		// detached rejection here while exposing the terminal Promise to tests
		// and non-HTTP callers that want to await it.
		runtimeRegistry.track(result);
		return { accepted, runtime: activeRuntime, result };
	}

	private resolveTransport(database: Database, profileId: number | null): ResolvedGenerationTransport {
		const settingsModule = createConnectionSettingsModule(database, this.options);
		const settings = settingsModule.get();
		if (profileId === null) {
			throw new GenerationConfigurationError("Choose a model and connection before generating.");
		}
		const profile = settings.profiles.find((entry) => entry.id === profileId);
		if (profile === undefined) {
			throw new GenerationConfigurationError("The selected Connection Profile is unavailable.");
		}
		return {
			modelClient: createModelClient({
				profile,
				secrets: settingsModule.getProfileSecrets(profile.id),
				fetch: this.options.fetch,
				loadImage: imageLoader(database),
			}),
			connection: connectionSnapshotOf(settings, profile),
		};
	}
}

export function createGenerationCoordinator(
	database: Database,
	options: GenerationCoordinatorOptions = {},
): GenerationCoordinator {
	return new GenerationCoordinator(database, options);
}

const retainedInspectionCleanup = (
	database: Database,
	generationId: number,
) => () => removeRetainedGenerationInspection(database, generationId);
