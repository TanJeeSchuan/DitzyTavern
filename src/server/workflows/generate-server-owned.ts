import { GENERATION_DATA_NAMESPACE, GENERATION_DATA_KEYS } from "../../shared/variant-data-codecs";
import { variantDataCodecs, toVariantDataEntry } from "../../shared/variant-data-codecs";
import type { Database } from "bun:sqlite";
import type { AcceptedGenerationRecord, GenerationInput } from "./generate";
import {
	collectModelClientGeneration,
	ModelClientGenerationError,
	normalizeUsage,
	type ModelClient,
	type ModelClientGenerationInput,
	type ModelClientConnectionSnapshot,
	type ModelClientEvent,
	type ModelClientFailureKind,
} from "../model-client";
import type { ConnectionSettingsModuleOptions } from "../connection-settings";
import type { ConversationDataEntry } from "../conversation";
import type { TokenEstimator } from "../prompt-compiler";
import type { ModelFetch } from "../model-client/types";
import type { GenerationFormattingContext } from "../../shared/contract/conversation-schema";

// @approved
//  Detached server-owned Generation scaffolding: the attempt input shared by
// every workflow, the accept/result handle detached from its observing
// request, and the provider-attempt tail (normalized outcome collection,
// empty-output removal, terminal provenance and data assembly). The workflow
// entry points own the Conversation lifecycle; this module owns everything
// that is identical across Send, Continue, and Sibling.

export interface GenerationAttemptInput {
	conversationId: number;
	// @approved
	//  Present on the revisioned lifecycles (Send, Continue) and absent on
	// Sibling, whose eligibility is revision-neutral. The lifecycle runner
	// reads it directly for its pre-capture fail-fast; the acceptance
	// transaction owns the authoritative guard.
	expectedRevision?: number;
	// @approved
	//  The provider-neutral Model Client receives the compiled Prompt Plan and
	// returns normalized asynchronous events. The workflow never calls a
	// provider or interprets a provider request shape directly.
	modelClient: ModelClient;
	connection: ModelClientConnectionSnapshot | null;
	connectionSettings?: ConnectionSettingsModuleOptions;
	// @approved
	//  The signal belongs to this one Generation. A cancelled attempt never
	// changes another Conversation's model selection.
	signal?: AbortSignal;
	onEvent?: (event: ModelClientEvent) => void | Promise<void>;
	/** @approved Flush process-local output before the workflow performs a terminal write. */
	onBeforeTerminal?: () => void | Promise<void>;
	// @approved
	//  Tests and future calibration work may replace the default project-owned
	// estimator without allowing a provider to influence budgeting policy.
	tokenEstimator?: TokenEstimator;
	// @approved
	//  Optional explicit write time; defaults to the current wall clock.
	timestamp?: string | undefined;
	// @approved
	//  Initiating-client formatting context. The capture
	// carries this one value through budgeting and send.
	formatting?: GenerationFormattingContext;
	/** @approved Optional embedding transport seam; production uses the standard fetch implementation. */
	preparationFetch?: ModelFetch;
}

/** @approved Provider cancellation handle passed only to the server-owned runtime seam. */
export interface ServerOwnedGenerationControl {
	readonly signal: AbortSignal;
	stop(): void;
}

/** @approved The detached server-owned Generation handle shared by every lifecycle. */
export interface ServerOwnedGeneration {
	/** @approved Resolves as soon as the provisional target is committed. */
	readonly accepted: Promise<AcceptedGenerationRecord>;
	/** @approved Resolves/rejects when the provider attempt and terminal commit finish. */
	readonly result: Promise<AcceptedGenerationRecord>;
	/** @approved Cancellation owned by the generation, never by an observing request. */
	readonly signal: AbortSignal;
}

export interface ServerOwnedGenerationCallbacks {
	onAccepted?: (accepted: AcceptedGenerationRecord, control: ServerOwnedGenerationControl) => void | Promise<void>;
	onEvent?: (event: ModelClientEvent) => void | Promise<void>;
}

/** @approved
 * Detach one Generation from its observing request.
 *
 * Acceptance is exposed separately so an HTTP caller can return as soon as
 * the provisional target exists. The provider attempt remains owned by the
 * controller until its terminal result settles, regardless of request
 * disconnects. Input composition is identical for every lifecycle: the
 * caller's own callbacks fire first, then the detached observer callbacks,
 * and the provider signal replaces whatever the observing request owned.
 */
export function startServerOwnedGenerationFrom(
	database: Database,
	input: GenerationInput,
	start: (database: Database, input: GenerationInput) => Promise<AcceptedGenerationRecord>,
	callbacks: ServerOwnedGenerationCallbacks = {},
): ServerOwnedGeneration {
	const controller = new AbortController();
	let accepted = false;
	let resolveAccepted!: (value: AcceptedGenerationRecord) => void;
	let rejectAccepted!: (reason: Error) => void;
	const acceptedPromise = new Promise<AcceptedGenerationRecord>((resolve, reject) => {
		resolveAccepted = resolve;
		rejectAccepted = reject;
	});
	const result = start(database, {
		...input,
		signal: controller.signal,
		onAccepted: async (value) => {
			await input.onAccepted?.(value);
			accepted = true;
			resolveAccepted(value);
			await callbacks.onAccepted?.(value, {
				signal: controller.signal,
				stop: () => controller.abort(),
			});
		},
		onEvent: async (event) => {
			await input.onEvent?.(event);
			await callbacks.onEvent?.(event);
		},
	});
	void result.catch((error) => {
		if (!accepted) {
			rejectAccepted(error instanceof Error ? error : new Error("Generation could not be accepted."));
		}
	});
	return { accepted: acceptedPromise, result, signal: controller.signal };
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

// @approved
//  The transport has one failure policy for both current and sibling
// generations: preserve visible output when a stream fails after producing it,
// but leave zero-output failures to the caller. Keeping that policy here means
// commit paths only decide which Conversation operation receives the outcome.
export async function runGeneration(
	modelClient: ModelClient,
	input: ModelClientGenerationInput,
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
	/** @approved Commit the normalized terminal outcome to the accepted target. */
	resolve(outcome: GenerationOutcome): TResult | Promise<TResult>;
	/** @approved Remove the accepted target only after a confirmed zero-output result. */
	remove(): void | Promise<void>;
}

/** @approved
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
	request: ModelClientGenerationInput,
	lifecycle: AcceptedGenerationLifecycle<TResult>,
): Promise<TResult> {
	let outcome: GenerationOutcome;
	try {
		outcome = await runGeneration(input.modelClient, request, input.onEvent);
	} catch (error) {
		// @approved
		//  Only a provider failure reaches this path: resolution runs
		// outside the try, so a persistence error can never delete committed
		// output. Removal stays a zero-output cleanup because removeGeneration
		// refuses a target that already holds durable checkpointed output —
		// such a target survives here for recovery to finish.
		await input.onBeforeTerminal?.();
		try {
			await lifecycle.remove();
		} catch {
			// @approved
			// Preserve the provider error; recovery owns any surviving target.
		}
		throw error;
	}
	await input.onBeforeTerminal?.();
	if (outcome.content.length === 0 && outcome.reasoning.length === 0) {
		await lifecycle.remove();
		throw new ModelClientGenerationError("provider", "Generation produced no usable output.");
	}
	return lifecycle.resolve(outcome);
}

export function generationOutcomeData(input: GenerationOutcome): ConversationDataEntry[] {
	const data: ConversationDataEntry[] = [];
	if (input.status !== "complete") {
		data.push({ namespace: GENERATION_DATA_NAMESPACE, key: GENERATION_DATA_KEYS.outcome, value: input.status });
	}
	if (input.reasoning.length > 0) {
		data.push(toVariantDataEntry(variantDataCodecs.reasoning, variantDataCodecs.reasoning.encode(input.reasoning)));
	}
	if (input.usage !== null) {
		data.push({
			namespace: GENERATION_DATA_NAMESPACE,
			key: GENERATION_DATA_KEYS.usage,
			value: JSON.stringify(normalizeUsage(input.usage)),
		});
	}
	if (input.finishReason !== null) {
		data.push({
			namespace: GENERATION_DATA_NAMESPACE,
			key: GENERATION_DATA_KEYS.finish,
			value: JSON.stringify({
				reason: input.finishReason,
			}),
		});
	}
	if (input.interruptionCause !== null) {
		data.push({
			namespace: GENERATION_DATA_NAMESPACE,
			key: GENERATION_DATA_KEYS.interruptionCause,
			value: input.interruptionCause,
		});
	}
	if (input.error !== null) {
		data.push({
			namespace: GENERATION_DATA_NAMESPACE,
			key: "error",
			value: input.error.slice(0, 16_384),
		});
	}
	return data;
}

/** @approved
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
