import { variantDataCodecs, toVariantDataEntry } from "../../shared/variant-data-codecs";
import {
	readConversationRevision,
	removeConversationGeneration,
	checkpointConversationGeneration,
	resolveConversationGeneration,
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
	const accepted = acceptCapturedGeneration(database, input, capture, timestamp);
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
			checkpointConversationGeneration(database, { conversationId: input.conversationId, generationId: accepted.generationId, content: outcome.content, reasoning: outcome.reasoning });
			const resolved = resolveConversationGeneration(database, {
				conversationId: input.conversationId,
				generationId: accepted.generationId,
				timestamp,
				content: outcome.content,
				data: [
					...(capture.facts.kind === "continuation" ? [toVariantDataEntry(variantDataCodecs.intent, variantDataCodecs.intent.encode(capture.facts.intent))] : []),
					...generationOutcomeData(outcome),
				],
			});
			return { ...accepted, conversation: resolved };
		},
	});
}

function acceptCapturedGeneration(database: Database, input: GenerationInput, capture: CapturedGeneration, timestamp: string): AcceptedGenerationRecord {
	const fields = capturedAcceptanceFields(capture, { conversationId: input.conversationId, timestamp });
	switch (capture.target.kind) {
		case "send":
			if (input.expectedRevision === undefined || capture.facts.kind !== "send") throw new Error("Send capture is incomplete.");
			return acceptConversationTailGeneration(database, { ...fields, expectedRevision: input.expectedRevision, humanContent: capture.target.content,
				reuseHumanMessageId: capture.facts.reuseHumanMessageId });
		case "continuation":
			if (input.expectedRevision === undefined || capture.facts.kind !== "continuation") throw new Error("Continuation capture is incomplete.");
			return acceptConversationContinuationGeneration(database, { ...fields, expectedRevision: input.expectedRevision,
				precedingMessageId: capture.facts.precedingMessageId, precedingVariantId: capture.facts.precedingVariantId,
				generationIntent: capture.facts.intent });
		case "sibling":
			return acceptConversationSiblingGeneration(database, { ...fields, messageId: capture.target.messageId, generationIntent: { type: "sibling" } });
	}
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
export function startServerOwnedGeneration(database: Database, input: GenerationInput, callbacks: ServerOwnedGenerationCallbacks = {}): ServerOwnedGeneration {
	const controller = new AbortController();
	let accepted = false;
	let resolveAccepted!: (value: AcceptedGenerationRecord) => void;
	let rejectAccepted!: (reason: Error) => void;
	const acceptedPromise = new Promise<AcceptedGenerationRecord>((resolve, reject) => {
		resolveAccepted = resolve;
		rejectAccepted = reject;
	});
	const result = runGenerationLifecycle(database, {
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
