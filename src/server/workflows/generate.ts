import { variantDataCodecs, toVariantDataEntry } from "../../shared/variant-data-codecs";
import {
	readConversationRevision,
	stopConversationGeneration,
	resolveConversationGeneration,
	checkpointUnstreamedOutcome,
	acceptGeneration,
	ConversationNotFoundError,
	type AcceptedGeneration,
} from "../conversation";
import type { Database } from "bun:sqlite";
import { StaleRevisionError } from "../revision";
import { generationRuntimeFor } from "./generation-runtime";
import {
	runAcceptedGeneration,
	generationOutcomeData,
	type GenerationAttemptInput,
	type ServerOwnedGeneration,
	type ServerOwnedGenerationCallbacks,
} from "./generate-server-owned";
import { withGenerationBoxOperations, captureGeneration } from "./generate-capture";
import { capturedAcceptanceFields, modelRequestFor } from "./generate-capture-projections";
import { consumeGenerationPreview, captureGenerationPreview, type GenerationPreviewAcceptance } from "./generation-preview";
import { assertGenerationPlan } from "../generation-plan";
import type { GenerationTarget } from "../../shared/contract/conversation-schema";

export type { ServerOwnedGenerationControl, ServerOwnedGeneration, ServerOwnedGenerationCallbacks } from "./generate-server-owned";

export interface GenerationInput extends GenerationAttemptInput {
	readonly target: GenerationTarget;
	readonly preview?: GenerationPreviewAcceptance;
	readonly onAccepted?: (accepted: AcceptedGeneration) => void | Promise<void>;
}

export async function runGenerationLifecycle(database: Database, input: GenerationInput): Promise<AcceptedGeneration> {
	const revision = readConversationRevision(database, input.conversationId);
	if (revision === undefined) throw new ConversationNotFoundError(input.conversationId);
	if (input.expectedRevision !== undefined && revision !== input.expectedRevision) {
		throw new StaleRevisionError("generation", input.expectedRevision, revision);
	}
	const { preview } = input;
	const capture = preview === undefined
		? await captureGeneration(database, input.target, input)
		: await withGenerationBoxOperations({ database, ...input }, () => captureGenerationPreview({ database, ...input }, preview, input.target));
	generationRuntimeFor(database).assertAccepting();
	assertGenerationPlan(capture.plan);
	const timestamp = input.timestamp ?? new Date().toISOString();
	const { target } = capture.preparation;
	const acceptanceTarget = target.kind === "sibling" ? target : { ...target, expectedRevision: revision };
	const accepted = acceptGeneration(database, capturedAcceptanceFields(capture, timestamp), acceptanceTarget);
	if (input.preview !== undefined) consumeGenerationPreview(database, input.preview.record);
	try {
		await input.onAccepted?.(accepted);
	} catch {
		// @approved
		// Acceptance is authoritative even when an observing caller disconnects.
	}
	return runAcceptedGeneration(input, modelRequestFor(capture, input), {
		stop: (cause) => { stopConversationGeneration(database, { conversationId: input.conversationId, generationId: accepted.generationId, cause }); },
		resolve: (outcome) => {
			checkpointUnstreamedOutcome(database, { conversationId: input.conversationId, generationId: accepted.generationId, content: outcome.content, reasoning: outcome.reasoning });
			const resolved = resolveConversationGeneration(database, {
				conversationId: input.conversationId,
				generationId: accepted.generationId,
				timestamp,
				content: outcome.content,
				reasoning: outcome.reasoning,
				data: [
					...(target.kind === "continuation" ? [toVariantDataEntry(variantDataCodecs.intent, variantDataCodecs.intent.encode(target.intent))] : []),
					...generationOutcomeData(outcome),
				],
			});
			return { ...accepted, conversation: resolved };
		},
	});
}

/** @approved
 * Detach one Generation from its observing request.
 *
 * Acceptance is exposed separately so an HTTP caller can return as soon as
 * the provisional target exists. The provider attempt remains owned by the
 * controller until its terminal result settles, regardless of request
 * disconnects. `accepted` resolves on commit, before any observer runs, and
 * the provider signal replaces whatever the observing request owned. The
 * observer's synchronous part still runs before an `accepted` continuation.
 */
export function startServerOwnedGeneration(database: Database, input: Omit<GenerationInput, "onAccepted" | "onEvent">, callbacks: ServerOwnedGenerationCallbacks = {}): ServerOwnedGeneration {
	const controller = new AbortController();
	const accepted = Promise.withResolvers<AcceptedGeneration>();
	const result = runGenerationLifecycle(database, {
		...input,
		signal: controller.signal,
		onAccepted: (value) => {
			accepted.resolve(value);
			return callbacks.onAccepted?.(value, { signal: controller.signal, stop: () => controller.abort() });
		},
		onEvent: callbacks.onEvent,
	});
	void result.catch(accepted.reject);
	return { accepted: accepted.promise, result, signal: controller.signal };
}
