import type { Database } from "bun:sqlite";
import { openDatabase, withDatabase } from "../database/database";
import {
	checkpointConversationGeneration,
	ConversationNotFoundError,
	InvalidConversationCommandError,
	createConversationModule,
	removeRetainedGenerationInspection,
	type AcceptedContinuationGeneration,
	type AcceptedSiblingGeneration,
	type AcceptedTailGeneration,
	type ConversationSnapshot,
	type StopGenerationInput,
	type StopGenerationsInput,
	type StoppedGenerations,
} from "../conversation";
import {
	connectionSnapshotOf,
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
	generationRuntimeFor,
	type GenerationRuntime,
	type GenerationRuntimeState,
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

/** ==[HUMAN APPROVED]== Dependencies needed by the HTTP/application generation adapter. */
export interface GenerationCoordinatorOptions extends ConnectionSettingsModuleOptions {
	readonly fetch?: ModelFetch;
	/**
	 * ==[HUMAN APPROVED]== Composition seam for the durable Conversation stop transitions. Production
	 * resolves the deep Conversation module; composed callers and tests may
	 * substitute their own adapter.
	 */
	readonly conversationLifecycle?: GenerationConversationLifecycle;
	/** ==[HUMAN APPROVED]== Composition seam for the process runtime registry used by Stop and Stop All. */
	readonly runtimeLifecycle?: GenerationRuntimeLifecycle;
}

/**
 * ==[HUMAN APPROVED]== The durable Conversation stop transitions the Coordinator composes with
 * runtime mechanics. The deep Conversation module owns these atomic durable
 * transitions and their database invariants; it never learns runtime mechanics.
 */
export interface GenerationConversationLifecycle {
	stopGeneration(input: StopGenerationInput): ConversationSnapshot;
	stopGenerations(input: StopGenerationsInput): StoppedGenerations;
}

/** ==[HUMAN APPROVED]== The process runtime entry the Coordinator settles on Stop. */
export interface GenerationRuntimeHandle {
	readonly state: GenerationRuntimeState;
	/** ==[HUMAN APPROVED]== Aborts the provider attempt and flushes the latest runtime checkpoint. */
	stop(): void;
	/** ==[HUMAN APPROVED]== Marks the runtime terminal after the durable Stop transition committed. */
	markStopped(): void;
	/** ==[HUMAN APPROVED]== Returns terminal ownership to the provider after a losing Stop race. */
	releaseStopRequest(): void;
}

/** ==[HUMAN APPROVED]== The process runtime registry seam the Coordinator consults for Stop. */
export interface GenerationRuntimeLifecycle {
	get(generationId: number): GenerationRuntimeHandle | undefined;
	/** ==[HUMAN APPROVED]== Forces a checkpoint on every runtime of one Conversation without aborting. */
	flushAll(conversationId: number): void;
}

/**
 * ==[HUMAN APPROVED]== Typed application outcome of stopping one server-owned Generation. These
 * outcomes carry no HTTP terminology; transports map them onto their own
 * response vocabulary.
 */
export type GenerationStopOutcome =
	| {
			/** ==[HUMAN APPROVED]== The durable interrupted transition committed and the runtime settled. */
			readonly outcome: "stopped";
			readonly generationId: number;
			readonly conversation: ConversationSnapshot;
	  }
	| {
			/**
			 * ==[HUMAN APPROVED]== The Generation completed naturally while the Stop was in flight. The
			 * losing Stop request was released, so the provider's own terminal
			 * event settles the runtime and no interrupted transition was committed.
			 */
			readonly outcome: "already-terminal";
			readonly generationId: number;
	  }
	| {
			/** ==[HUMAN APPROVED]== Nothing was stoppable: unknown target, or a Conversation that is gone. */
			readonly outcome: "missing";
			readonly generationId: number;
	  }
	| {
			/**
			 * ==[HUMAN APPROVED]== The runtime entry for that Generation belongs to a different
			 * Conversation than the one addressed. Nothing was stopped.
			 */
			readonly outcome: "conflict";
			readonly generationId: number;
	  }
	| {
			/**
			 * ==[HUMAN APPROVED]== The durable interrupted transition committed, but settling the
			 * process runtime failed. The returned Conversation snapshot remains
			 * the authoritative result of the Stop.
			 */
			readonly outcome: "incomplete-settlement";
			readonly generationId: number;
			readonly conversation: ConversationSnapshot;
			readonly reason: string;
	  };

/** ==[HUMAN APPROVED]== Typed application outcome of stopping every Active Generation of one Conversation. */
export type GenerationStopAllOutcome =
	| {
			/** ==[HUMAN APPROVED]== Every durable transition committed and its runtime settled. */
			readonly outcome: "stopped";
			readonly generationIds: readonly number[];
			readonly conversation: ConversationSnapshot;
	  }
	| {
			/** ==[HUMAN APPROVED]== The Conversation is unknown or has no Active Generations to stop. */
			readonly outcome: "missing";
	  }
	| {
			/**
			 * ==[HUMAN APPROVED]== Every durable transition committed, but some corresponding runtime
			 * entries could not be settled. The Conversation snapshot remains
			 * authoritative; the unsettled runtime entries are listed by id.
			 */
			readonly outcome: "incomplete-settlement";
			readonly generationIds: readonly number[];
			readonly unsettled: readonly number[];
			readonly conversation: ConversationSnapshot;
			readonly reason: string;
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
}

interface ServerOwnedGenerationHandle<TAccepted, TResult> {
	readonly accepted: Promise<TAccepted>;
	readonly result: Promise<TResult>;
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
		});
	}

	/**
	 * ==[HUMAN APPROVED]== Stop one server-owned Generation: request provider cancellation with a
	 * forced final checkpoint, commit the durable interrupted transition, then
	 * settle the process runtime. The typed outcome is the only application
	 * result; transports map it onto their own response vocabulary.
	 */
	async stopGeneration(conversationId: number, generationId: number): Promise<GenerationStopOutcome> {
		return this.withLifecycleConnection((database) => {
			const runtimes = this.runtimeLifecycle();
			const runtime = runtimes.get(generationId);
			// ==[HUMAN APPROVED]== The runtime registry knows which Conversation owns this Generation.
			// A mismatch means the addressed Conversation has no such Generation;
			// durable state is never consulted under another Conversation's name.
			if (runtime !== undefined && runtime.state.conversationId !== conversationId) {
				return { outcome: "conflict", generationId } as const;
			}
			// ==[HUMAN APPROVED]== Stop flushes the latest runtime checkpoint before aborting the
			// provider, so the durable transition below observes every delta the
			// runtime saw. A settlement failure here is reported after the durable
			// transition commits: a runtime glitch must never lose a Stop intent.
			const settlementFailure = this.requestRuntimeStop(runtime);
			const conversation = this.conversationLifecycle(database);
			try {
				const snapshot = conversation.stopGeneration({ conversationId, generationId });
				return this.settleStoppedGeneration(generationId, runtime, snapshot, settlementFailure);
			} catch (error) {
				if (error instanceof InvalidConversationCommandError) {
					if (runtime === undefined) return { outcome: "missing", generationId } as const;
					// ==[HUMAN APPROVED]== The Active Generation vanished while this Stop was in flight:
					// the natural-completion race. Release the Stop request so the
					// provider's own terminal event settles the runtime.
					runtime.releaseStopRequest();
					return { outcome: "already-terminal", generationId } as const;
				}
				if (error instanceof ConversationNotFoundError) {
					// ==[HUMAN APPROVED]== The Conversation is gone; the provider attempt cannot durably
					// commit either. Release the Stop request so the runtime still
					// settles through its own terminal path.
					runtime?.releaseStopRequest();
					return { outcome: "missing", generationId } as const;
				}
				throw error;
			}
		});
	}

	/**
	 * ==[HUMAN APPROVED]== Stop every Active Generation of one Conversation: force checkpoints
	 * without aborting, commit the durable interrupted transition for the
	 * complete target set, and only then settle the corresponding runtimes.
	 * The Conversation stays authoritative during races: runtimes are settled
	 * exclusively for targets the durable transition actually committed.
	 */
	async stopAllGenerations(conversationId: number): Promise<GenerationStopAllOutcome> {
		return this.withLifecycleConnection((database) => {
			const runtimes = this.runtimeLifecycle();
			// ==[HUMAN APPROVED]== Forced checkpoints without aborting first. The durable transition
			// below owns the complete target set; runtimes are settled only after
			// its commit succeeds.
			runtimes.flushAll(conversationId);
			const conversation = this.conversationLifecycle(database);
			try {
				const stopped = conversation.stopGenerations({ conversationId });
				const unsettled: number[] = [];
				let reason: string | undefined;
				for (const generationId of stopped.generationIds) {
					const runtime = runtimes.get(generationId);
					if (runtime?.state.conversationId !== conversationId) continue;
					try {
						runtime.stop();
						runtime.markStopped();
					} catch (error) {
						unsettled.push(generationId);
						reason ??= error instanceof Error
							? error.message
							: "The Generation runtime could not be settled.";
					}
				}
				if (unsettled.length > 0) {
					return {
						outcome: "incomplete-settlement",
						generationIds: stopped.generationIds,
						unsettled,
						conversation: stopped.conversation,
						reason: reason ?? "The Generation runtime could not be settled.",
					} as const;
				}
				return {
					outcome: "stopped",
					generationIds: stopped.generationIds,
					conversation: stopped.conversation,
				} as const;
			} catch (error) {
				if (
					error instanceof ConversationNotFoundError ||
					error instanceof InvalidConversationCommandError
				) {
					return { outcome: "missing" } as const;
				}
				throw error;
			}
		});
	}

	private requestRuntimeStop(runtime: GenerationRuntimeHandle | undefined): string | undefined {
		if (runtime === undefined) return undefined;
		try {
			runtime.stop();
			return undefined;
		} catch (error) {
			return error instanceof Error
				? error.message
				: "The Generation runtime could not be stopped.";
		}
	}

	private settleStoppedGeneration(
		generationId: number,
		runtime: GenerationRuntimeHandle | undefined,
		snapshot: ConversationSnapshot,
		settlementFailure: string | undefined,
	): GenerationStopOutcome {
		if (runtime === undefined) {
			return { outcome: "stopped", generationId, conversation: snapshot };
		}
		let failure = settlementFailure;
		if (failure === undefined) {
			try {
				runtime.markStopped();
				return { outcome: "stopped", generationId, conversation: snapshot };
			} catch (error) {
				failure = error instanceof Error
					? error.message
					: "The Generation runtime could not be settled.";
			}
		}
		return {
			outcome: "incomplete-settlement",
			generationId,
			conversation: snapshot,
			reason: failure,
		};
	}

	/**
	 * ==[HUMAN APPROVED]== Resolves the durable Conversation stop adapter: the composed seam when
	 * provided, otherwise the deep Conversation module over the request or
	 * configured database.
	 */
	private conversationLifecycle(database: Database | undefined): GenerationConversationLifecycle {
		if (this.options.conversationLifecycle !== undefined) return this.options.conversationLifecycle;
		if (database === undefined) {
			throw new Error("Generation lifecycle operations require a Conversation adapter or database.");
		}
		return createConversationModule(database);
	}

	/**
	 * ==[HUMAN APPROVED]== Opens the short-lived request database only when neither a composed
	 * Conversation adapter nor a configured database supplies one, and always
	 * closes a connection it opened itself.
	 */
	private withLifecycleConnection<T>(run: (database: Database | undefined) => T): T {
		if (this.options.conversationLifecycle !== undefined) return run(undefined);
		if (this.configuredDatabase !== undefined) return run(this.configuredDatabase);
		const database = openDatabase();
		try {
			return run(database);
		} finally {
			database.close();
		}
	}

	/** ==[HUMAN APPROVED]== The runtime lifecycle seam for Stop and Stop All: the composed seam when provided. */
	private runtimeLifecycle(): GenerationRuntimeLifecycle {
		if (this.options.runtimeLifecycle !== undefined) return this.options.runtimeLifecycle;
		return generationRuntimeFor(this.configuredDatabase);
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
			const runtimeRegistry = generationRuntimeFor(this.configuredDatabase);
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
			// ==[HUMAN APPROVED]== The HTTP adapter intentionally returns after acceptance. Consume the
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
			connection: connectionSnapshotOf(settings, profile),
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
