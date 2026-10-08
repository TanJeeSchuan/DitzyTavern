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
	StaleConversationRevisionError,
	type AcceptedTailGeneration,
	type AcceptedContinuationGeneration,
	type AcceptedSiblingGeneration,
} from "../conversation";
import { generationRuntimeFor } from "./generation-runtime";
import {
	runAcceptedGeneration,
	generationOutcomeData,
	startServerOwnedGenerationFrom,
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
		throw new StaleConversationRevisionError(input.expectedRevision, revision);
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
			return acceptConversationTailGeneration(database, { ...fields, expectedRevision: input.expectedRevision, humanContent: capture.target.content, reuseHumanMessageId: capture.facts.reuseHumanMessageId });
		case "continuation":
			if (input.expectedRevision === undefined || capture.facts.kind !== "continuation") throw new Error("Continuation capture is incomplete.");
			return acceptConversationContinuationGeneration(database, { ...fields, expectedRevision: input.expectedRevision, precedingMessageId: capture.facts.precedingMessageId, precedingVariantId: capture.facts.precedingVariantId, generationIntent: capture.facts.intent });
		case "sibling":
			return acceptConversationSiblingGeneration(database, { ...fields, messageId: capture.target.messageId, generationIntent: { type: "sibling" } });
	}
}

export function startServerOwnedGeneration(database: Database, input: GenerationInput, callbacks: ServerOwnedGenerationCallbacks = {}): ServerOwnedGeneration {
	return startServerOwnedGenerationFrom(database, input, runGenerationLifecycle, callbacks);
}
