import { variantDataCodecs, toVariantDataEntry } from "../../shared/variant-data-codecs";
import type { CapturedGeneration } from "./generate-capture";
import type { GenerationAttemptInput } from "./generate-server-owned";
import type { GenerationAcceptanceCapture, ConversationDataEntry } from "../conversation";
import type { GenerationPlan } from "../generation-plan";
import type { PromptBudgetResult } from "../prompt-compiler";
import type { GenerationBudgetInspection } from "../../shared/contract/conversation-schema";
import { projectModelClientGenerationSettings, type ModelClientConnectionSnapshot, type ModelClientGenerationInput } from "../model-client";
import {
	type GenerationProvenanceRecord,
	type GenerationProvenanceSettings,
} from "../../shared/contract/generation-provenance";


const generationProvenanceEntry = (
	plan: GenerationPlan,
	connection: ModelClientConnectionSnapshot | null,
): ConversationDataEntry => {
	const generationSettings = {
		temperature: plan.effectiveSettings.temperature,
		topP: plan.effectiveSettings.topP,
		frequencyPenalty: plan.effectiveSettings.frequencyPenalty,
		presencePenalty: plan.effectiveSettings.presencePenalty,
		contextLimit: plan.effectiveSettings.contextLimit,
		responseBudget: plan.effectiveSettings.responseBudget,
		safetyAllowance: plan.effectiveSettings.safetyAllowance,
		siblingGenerationLimit: plan.effectiveSettings.siblingGenerationLimit,
		continuationStrategy: plan.effectiveSettings.continuationStrategy,
		continuationInstruction: plan.effectiveSettings.continuationInstruction,
		continuationPrefillSuffix: plan.effectiveSettings.continuationPrefillSuffix,
		repeatedImagePlacement: plan.effectiveSettings.repeatedImagePlacement,
	} satisfies GenerationProvenanceSettings;
	const provenanceRecord: GenerationProvenanceRecord = {
		connectionProfileId: connection?.profileId ?? null,
		connectionSettingsRevision: connection?.settingsRevision ?? null,
		modelBackend: connection?.backend ?? null,
		adapter: connection?.adapter ?? null,
		modelId: plan.effectiveSettings.modelId,
		generationSettings,
		usage: null,
		finishReason: null,
		status: null,
		interruptionCause: null,
	};
	return toVariantDataEntry(variantDataCodecs.provenance, variantDataCodecs.provenance.encode(provenanceRecord));
};


/** @approved Project the captured plan and participants into Conversation's acceptance input. */
export function capturedAcceptanceFields(
	{ preparation, plan, macroWrites }: CapturedGeneration,
	timestamp: string,
): GenerationAcceptanceCapture {
	const { human, model } = preparation.derivation;
	return {
		seed: preparation.seed,
		boxRecords: preparation.boxRecords,
		conversationId: preparation.conversationId,
		timestamp,
		humanParticipantId: human.id,
		modelParticipantId: model.id,
		capturedHumanName: human.name,
		capturedModelName: model.name,
		modelId: plan.effectiveSettings.modelId,
		promptPlan: plan.promptPlan,
		promptInspection: promptInspectionOf(plan.budget),
		loreActivation: plan.loreActivation,
		boxTraces: plan.boxTraces,
		provenance: generationProvenanceEntry(plan, preparation.connection),
		macro: { presetId: preparation.recipe.id, writes: macroWrites },
	};
}

export function modelRequestFor(
	{ preparation, plan }: CapturedGeneration,
	input: Pick<GenerationAttemptInput, "signal">,
): ModelClientGenerationInput {
	return {
		promptPlan: plan.promptPlan,
		modelId: plan.effectiveSettings.modelId,
		generationSettings: projectModelClientGenerationSettings(plan.effectiveSettings),
		connection: preparation.connection,
		signal: input.signal,
	};
}

// @approved
//  Active inspection keeps the exact budget decision made at Generation
// start, including the whole history entries omitted during preflight. It is
// deliberately not copied into terminal Variant provenance.
const promptInspectionOf = (budget: PromptBudgetResult): GenerationBudgetInspection => ({
	tokenEstimate: budget.tokenEstimate,
	responseBudget: budget.responseBudget,
	safetyAllowance: budget.safetyAllowance,
	contextLimit: budget.contextLimit,
	totalRequiredTokens: budget.totalRequiredTokens,
	omittedContext: [...budget.omittedContext],
});
