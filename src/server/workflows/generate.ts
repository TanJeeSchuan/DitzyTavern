import type { Database } from "bun:sqlite";
import {
	createConversationModule,
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
	const conversation = createConversationModule(database);
	const revision = conversation.getRevision(input.conversationId);
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
		remove: () => { conversation.removeGeneration({ conversationId: input.conversationId, generationId: accepted.generationId }); },
		resolve: (outcome) => {
			conversation.checkpointGeneration({ conversationId: input.conversationId, generationId: accepted.generationId, content: outcome.content, reasoning: outcome.reasoning });
			const resolved = conversation.resolveGeneration({
				conversationId: input.conversationId,
				generationId: accepted.generationId,
				timestamp,
				content: outcome.content,
				data: [
					...(capture.target.kind === "continuation" ? [{ namespace: "generation", key: "intent", value: JSON.stringify(capture.intent) }] : []),
					...generationOutcomeData(outcome),
				],
			});
			return { ...accepted, conversation: resolved };
		},
	});
}

function acceptCapturedGeneration(database: Database, input: GenerationInput, capture: CapturedGeneration, timestamp: string): AcceptedGenerationRecord {
	const conversation = createConversationModule(database);
	const fields = capturedAcceptanceFields(capture, { conversationId: input.conversationId, timestamp });
	switch (capture.target.kind) {
		case "send":
			if (input.expectedRevision === undefined || capture.facts.kind !== "send") throw new Error("Send capture is incomplete.");
			return conversation.acceptTailGeneration({ ...fields, expectedRevision: input.expectedRevision, humanContent: capture.target.content, reuseHumanMessageId: capture.facts.reuseHumanMessageId });
		case "continuation":
			if (input.expectedRevision === undefined || capture.facts.kind !== "continuation") throw new Error("Continuation capture is incomplete.");
			return conversation.acceptContinuationGeneration({ ...fields, expectedRevision: input.expectedRevision, precedingMessageId: capture.facts.precedingMessageId, precedingVariantId: capture.facts.precedingVariantId, generationIntent: capture.facts.intent });
		case "sibling":
			return conversation.acceptSiblingGeneration({ ...fields, messageId: capture.target.messageId, generationIntent: { type: "sibling" } });
	}
}

export function startServerOwnedGeneration(database: Database, input: GenerationInput, callbacks: ServerOwnedGenerationCallbacks = {}): ServerOwnedGeneration {
	return startServerOwnedGenerationFrom(database, input, runGenerationLifecycle, callbacks);
}
