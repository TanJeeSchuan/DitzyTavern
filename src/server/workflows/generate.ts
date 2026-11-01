import { variantDataCodecs, toVariantDataEntry } from "../../shared/variant-data-codecs";
import {
	readConversationRevision,
	removeConversationGeneration,
	resolveConversationGeneration,
	checkpointUnstreamedOutcome,
	acceptConversationTailGeneration,
	acceptConversationContinuationGeneration,
	acceptConversationSiblingGeneration,
} from "../conversation";
import type { Database } from "bun:sqlite";
import {
	ConversationNotFoundError,
	type AcceptedTailGeneration,
	type AcceptedContinuationGeneration,
	type AcceptedSiblingGeneration,
} from "../conversation";
import { StaleRevisionError } from "../revision";
import { generationRuntimeFor } from "./generation-runtime";
import {
	runAcceptedGeneration,
	generationOutcomeData,
	type GenerationAttemptInput,
	type ServerOwnedGeneration,
	type ServerOwnedGenerationCallbacks,
} from "./generate-server-owned";
import { captureGeneration, capturedAcceptanceFields, modelRequestFor, type CapturedGeneration } from "./generate-capture";
import { consumeGenerationPreview, captureGenerationPreview, type GenerationPreviewAcceptance } from "./generation-preview";
import { assertGenerationPlan } from "../generation-plan";
import type { GenerationTarget } from "../../shared/contract/conversation-schema";

export type { GenerationAttemptInput, ServerOwnedGenerationControl, ServerOwnedGeneration, ServerOwnedGenerationCallbacks } from "./generate-server-owned";
export type { ParticipantPreview } from "./generate-capture";

export type AcceptedGenerationRecord = AcceptedTailGeneration | AcceptedContinuationGeneration | AcceptedSiblingGeneration;

export interface GenerationInput extends GenerationAttemptInput {
	readonly target: GenerationTarget;
	readonly preview?: GenerationPreviewAcceptance;
	readonly onAccepted?: (accepted: AcceptedGenerationRecord) => void | Promise<void>;
}

export async function runGenerationLifecycle(database: Database, input: GenerationInput): Promise<AcceptedGenerationRecord> {
	const revision = readConversationRevision(database, input.conversationId);
	if (revision === undefined) throw new ConversationNotFoundError(input.conversationId);
	if (input.expectedRevision !== undefined && revision !== input.expectedRevision) {
		throw new StaleRevisionError("generation", input.expectedRevision, revision);
	}
	const capture = input.preview === undefined
		? await captureGeneration(database, input.target, input)
		: captureGenerationPreview({ database, ...input }, input.preview, input.target);
	generationRuntimeFor(database).assertAccepting();
	assertGenerationPlan(capture.plan);
	const timestamp = input.timestamp ?? new Date().toISOString();
	const accepted = acceptCapturedGeneration(database, capture, { conversationId: input.conversationId, revision, timestamp });
	if (input.preview !== undefined) consumeGenerationPreview(database, input.preview.record);
	try {
		await input.onAccepted?.(accepted);
	} catch {
		// @approved
		// Acceptance is authoritative even when an observing caller disconnects.
	}
	return runAcceptedGeneration(input, modelRequestFor(capture, input), {
		remove: () => { removeConversationGeneration(database, { conversationId: input.conversationId, generationId: accepted.generationId }); },
		resolve: (outcome) => {
			checkpointUnstreamedOutcome(database, { conversationId: input.conversationId, generationId: accepted.generationId, content: outcome.content, reasoning: outcome.reasoning });
			const resolved = resolveConversationGeneration(database, {
				conversationId: input.conversationId,
				generationId: accepted.generationId,
				timestamp,
				content: outcome.content,
				reasoning: outcome.reasoning,
				data: [
					...(capture.target.kind === "continuation" ? [toVariantDataEntry(variantDataCodecs.intent, variantDataCodecs.intent.encode(capture.target.intent))] : []),
					...generationOutcomeData(outcome),
				],
			});
			return { ...accepted, conversation: resolved };
		},
	});
}

interface GenerationAcceptance { conversationId: number; revision: number; timestamp: string }

// @approved
//  Send and Continuation accept only while the Conversation still has the
// revision the lifecycle read before capturing, which a submitted expected
// revision has already matched. Sibling acceptance is revision-neutral.
function acceptCapturedGeneration(database: Database, capture: CapturedGeneration, acceptance: GenerationAcceptance): AcceptedGenerationRecord {
	const fields = capturedAcceptanceFields(capture, acceptance);
	const expectedRevision = acceptance.revision;
	const { target } = capture;
	switch (target.kind) {
		case "send": {
			const { content: humanContent, moves: humanMoves, reuseHumanMessageId } = target;
			return acceptConversationTailGeneration(database, { ...fields, expectedRevision, humanContent, humanMoves, reuseHumanMessageId });
		}
		case "continuation": {
			const { precedingMessageId, precedingVariantId, intent: generationIntent } = target;
			return acceptConversationContinuationGeneration(database, { ...fields, expectedRevision, precedingMessageId, precedingVariantId, generationIntent });
		}
		case "sibling":
			return acceptConversationSiblingGeneration(database, { ...fields, messageId: target.messageId, generationIntent: { type: "sibling" } });
	}
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
	const accepted = Promise.withResolvers<AcceptedGenerationRecord>();
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
