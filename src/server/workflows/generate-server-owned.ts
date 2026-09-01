import type { Database } from "bun:sqlite";
import {
	collectModelClientGeneration,
	ModelClientGenerationError,
	type ModelClient,
	type ModelClientConnectionSnapshot,
	type ModelClientEvent,
	type ModelClientFailureKind,
} from "../model-client";
import type { ConnectionSettingsModuleOptions } from "../connection-settings";
import type { ConversationDataEntry } from "../conversation";
import type { TokenEstimator } from "../prompt-compiler";

// Detached server-owned Generation scaffolding: the attempt input shared by
// every workflow, the accept/result handle detached from its observing
// request, and the provider-attempt tail (normalized outcome collection,
// empty-output removal, terminal provenance and data assembly). The workflow
// entry points own the Conversation lifecycle; this module owns everything
// that is identical across Send, Continue, and Sibling.

export interface GenerationAttemptInput {
	conversationId: number;
	// The provider-neutral Model Client receives the compiled Prompt Plan and
	// returns normalized asynchronous events. The workflow never calls a
	// provider or interprets a provider request shape directly.
	modelClient: ModelClient;
	// HTTP adapters provide the same start-time capture used to construct the
	// client. Direct workflow callers may omit it; the workflow resolves the
	// current safe Profile identity itself, preserving the original fake-client
	// seam used by domain tests.
	connection?: ModelClientConnectionSnapshot | null;
	connectionSettings?: ConnectionSettingsModuleOptions;
	// The signal belongs to this one Generation. A cancelled attempt never
	// changes the active Profile or another Conversation.
	signal?: AbortSignal;
	onEvent?: (event: import("../model-client").ModelClientEvent) => void | Promise<void>;
	/** Flush process-local output before the workflow performs a terminal write. */
	onBeforeTerminal?: () => void | Promise<void>;
	// Tests and future calibration work may replace the default project-owned
	// estimator without allowing a provider to influence budgeting policy.
	tokenEstimator?: TokenEstimator;
	// Optional explicit write time; defaults to the current wall clock.
	timestamp?: string | undefined;
}

/** Provider cancellation handle passed only to the server-owned runtime seam. */
export interface ServerOwnedGenerationControl {
	readonly signal: AbortSignal;
	stop(): void;
}

/** The detached server-owned Generation handle shared by every lifecycle. */
export interface ServerOwnedGeneration<Accepted, Result> {
	/** Resolves as soon as the provisional target is committed. */
	readonly accepted: Promise<Accepted>;
	/** Resolves/rejects when the provider attempt and terminal commit finish. */
	readonly result: Promise<Result>;
	/** Cancellation owned by the generation, never by an observing request. */
	readonly signal: AbortSignal;
}

export interface ServerOwnedGenerationCallbacks<Accepted> {
	onAccepted?: (accepted: Accepted, control: ServerOwnedGenerationControl) => void | Promise<void>;
	onEvent?: (event: ModelClientEvent) => void | Promise<void>;
}

/**
 * Detach one Generation from its observing request.
 *
 * Acceptance is exposed separately so an HTTP caller can return as soon as
 * the provisional target exists. The provider attempt remains owned by the
 * controller until its terminal result settles, regardless of request
 * disconnects.
 */
export function startServerOwnedGeneration<Accepted, Result>(
	execute: (
		signal: AbortSignal,
		onAccepted: (accepted: Accepted) => void | Promise<void>,
		onEvent: (event: ModelClientEvent) => void | Promise<void>,
	) => Promise<Result>,
	callbacks: ServerOwnedGenerationCallbacks<Accepted> = {},
): ServerOwnedGeneration<Accepted, Result> {
	const controller = new AbortController();
	let accepted = false;
	let resolveAccepted!: (value: Accepted) => void;
	let rejectAccepted!: (reason: Error) => void;
	const acceptedPromise = new Promise<Accepted>((resolve, reject) => {
		resolveAccepted = resolve;
		rejectAccepted = reject;
	});
	const result = execute(
		controller.signal,
		async (value) => {
			accepted = true;
			resolveAccepted(value);
			await callbacks.onAccepted?.(value, {
				signal: controller.signal,
				stop: () => controller.abort(),
			});
		},
		async (event) => {
			await callbacks.onEvent?.(event);
		},
	);
	void result.catch((error) => {
		if (!accepted) {
			rejectAccepted(error instanceof Error ? error : new Error("Generation could not be accepted."));
		}
	});
	return { accepted: acceptedPromise, result, signal: controller.signal };
}

/**
 * The one generic public detached-start seam behind the three startServerOwned*
 * wrappers. Input composition is identical everywhere: the caller's input
 * callbacks fire first, then the detached observer callbacks, and the provider
 * signal replaces whatever the observing request owned.
 */
export function startServerOwnedGenerationFrom<
	Accepted,
	Result,
	Input extends {
		signal?: AbortSignal;
		onEvent?: (event: ModelClientEvent) => void | Promise<void>;
		onAccepted?: (accepted: Accepted) => void | Promise<void>;
	},
>(
	database: Database,
	input: Input,
	start: (database: Database, input: Input) => Promise<Result>,
	callbacks: ServerOwnedGenerationCallbacks<Accepted> = {},
): ServerOwnedGeneration<Accepted, Result> {
	return startServerOwnedGeneration(
		(signal, onAccepted, onEvent) => start(database, {
			...input,
			signal,
			onAccepted: async (value) => {
				await input.onAccepted?.(value);
				await onAccepted(value);
			},
			onEvent: async (event) => {
				await input.onEvent?.(event);
				await onEvent(event);
			},
		}),
		callbacks,
	);
}

type GenerationOutcomeStatus = "complete" | "interrupted" | "length-limited";

export type GenerationInterruptionCause =
	| ModelClientFailureKind
	| "server-restart"
	| "server-shutdown";

export interface GenerationOutcome {
	content: string;
	reasoning: string;
	usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
	finishReason: "stop" | "length" | "other" | null;
	status: GenerationOutcomeStatus;
	interruptionCause: GenerationInterruptionCause | null;
	error: string | null;
}

// The transport has one failure policy for both current and sibling
// generations: preserve visible output when a stream fails after producing it,
// but leave zero-output failures to the caller. Keeping that policy here means
// commit paths only decide which Conversation operation receives the outcome.
export async function runGeneration(
	modelClient: ModelClient,
	input: Parameters<typeof collectModelClientGeneration>[1],
	onEvent: GenerationAttemptInput["onEvent"],
): Promise<GenerationOutcome> {
	try {
		const result = await collectModelClientGeneration(modelClient, input, { onEvent });
		return {
			...result,
			status: result.finishReason === "length" ? "length-limited" : "complete",
			interruptionCause: null,
			error: null,
		};
	} catch (error) {
		if (!(error instanceof ModelClientGenerationError)) throw error;
		const content = error.partial.content ?? "";
		const reasoning = error.partial.reasoning ?? "";
		if (content.length === 0 && reasoning.length === 0) throw error;

		return {
			content,
			reasoning,
			usage: error.partial.usage ?? null,
			finishReason: null,
			status: "interrupted",
			interruptionCause: error.kind,
			error: error.kind === "cancelled" ? null : error.message,
		};
	}
}

export interface AcceptedGenerationLifecycle<TResult> {
	/** Commit the normalized terminal outcome to the accepted target. */
	resolve(outcome: GenerationOutcome): TResult | Promise<TResult>;
	/** Remove the accepted target after a zero-output or unexpected failure. */
	remove(): void | Promise<void>;
}

/**
 * Run the common server-owned tail of a Generation.
 *
 * Send, Continue, and Sibling all differ at acceptance and at the final
 * Conversation operation, but their provider lifecycle is identical: collect
 * normalized output, remove an empty provisional target, and resolve a target
 * with visible output. Keeping that policy here makes those differences
 * explicit at the call sites instead of encoding three subtly drifting copies.
 */
export async function runAcceptedGeneration<TResult>(
	input: GenerationAttemptInput,
	request: Parameters<typeof collectModelClientGeneration>[1],
	lifecycle: AcceptedGenerationLifecycle<TResult>,
): Promise<TResult> {
	let removed = false;
	try {
		const outcome = await runGeneration(input.modelClient, request, input.onEvent);
		if (outcome.content.length === 0 && outcome.reasoning.length === 0) {
			await input.onBeforeTerminal?.();
			await lifecycle.remove();
			removed = true;
			throw new ModelClientGenerationError(
				"provider",
				"Generation produced no usable output.",
			);
		}
		await input.onBeforeTerminal?.();
		return await lifecycle.resolve(outcome);
	} catch (error) {
		// runGeneration converts visible provider failures into an interrupted
		// outcome. This cleanup path is therefore only for empty output and
		// unexpected failures. A successful empty-output removal must not be
		// attempted a second time after the synthetic provider error is thrown.
		if (!removed) {
			try {
				await lifecycle.remove();
			} catch {
				// Preserve the provider or commit error; recovery can clean an orphan.
			}
		}
		throw error;
	}
}

export function generationOutcomeData(input: GenerationOutcome): ConversationDataEntry[] {
	const data: ConversationDataEntry[] = [];
	if (input.status !== "complete") {
		data.push({ namespace: "generation", key: "outcome", value: input.status });
	}
	if (input.reasoning.length > 0) {
		data.push({ namespace: "generation", key: "reasoning", value: input.reasoning });
	}
	if (input.usage !== null) {
		data.push({
			namespace: "generation",
			key: "usage",
			value: JSON.stringify(normalizeUsage(input.usage)),
		});
	}
	if (input.finishReason !== null) {
		data.push({
			namespace: "generation",
			key: "finish",
			value: JSON.stringify({
				reason: input.finishReason,
			}),
		});
	}
	if (input.interruptionCause !== null) {
		data.push({
			namespace: "generation",
			key: "interruption-cause",
			value: input.interruptionCause,
		});
	}
	if (input.error !== null) {
		data.push({
			namespace: "generation",
			key: "error",
			value: input.error.slice(0, 16_384),
		});
	}
	return data;
}

/**
 * Encode a recovered or gracefully stopped Generation with the same terminal
 * data vocabulary used by a live interrupted provider attempt.
 */
export const interruptedGenerationData = (
	cause: GenerationInterruptionCause,
	reasoning: string,
): ConversationDataEntry[] => generationOutcomeData({
		content: "",
		reasoning,
		usage: null,
		finishReason: null,
		status: "interrupted",
		interruptionCause: cause,
		error: null,
});

function normalizeUsage(input: {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
}) {
	const usage: Record<string, number> = {};
	addUsage(usage, "inputTokens", input.inputTokens);
	addUsage(usage, "outputTokens", input.outputTokens);
	addUsage(usage, "totalTokens", input.totalTokens);
	return usage;
}

function addUsage(target: Record<string, number>, key: string, value: number | undefined): void {
	if (value !== undefined && Number.isFinite(value) && value >= 0) target[key] = value;
}
