import { variantDataCodecs, toVariantDataEntry } from "../../shared/variant-data-codecs";
import type { CapturedGeneration } from "./generate-capture";
import type { GenerationAttemptInput } from "./generate-server-owned";
import type { AcceptTailGenerationInput, ConversationDataEntry, ConversationJsonValue } from "../conversation";
import type { GenerationPlan } from "../generation-plan";
import type { PromptBudgetResult, PromptPlan } from "../prompt-compiler";
import { projectModelClientGenerationSettings, type ModelClientConnectionSnapshot, type ModelClientGenerationInput } from "../model-client";
import {
	type GenerationProvenanceRecord,
	type GenerationProvenanceSettings,
} from "../../shared/generation-provenance";

const connectionIdentityOf = (
	connection: ModelClientConnectionSnapshot | null,
): ConversationJsonValue => connection === null
	? null
	: {
			profileId: connection.profileId,
			settingsRevision: connection.settingsRevision,
			backend: connection.backend,
			adapter: connection.adapter,
			apiFormat: connection.apiFormat,
		};


export const generationProvenanceEntry = (
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


/** @approved
 * Project one captured Generation into the fields shared by every acceptance
 * command. Each lifecycle spreads this projection alongside its lifecycle-
 * specific target fields, keeping those differences visible at the callsite.
 */
export function capturedAcceptanceFields(
	capture: CapturedGeneration,
	input: { conversationId: number; timestamp: string },
) {
	return {
		conversationId: input.conversationId,
		timestamp: input.timestamp,
		humanParticipantId: capture.control.humanParticipantId,
		modelParticipantId: capture.control.modelParticipantId,
		capturedHumanName: capture.humanParticipant.name,
		capturedModelName: capture.author.capturedName,
		promptPlan: capture.plan.promptPlan,
		promptInspection: promptInspectionJson(capture.plan.budget),
		promptContext: capture.context,
		generationSettings: capture.plan.effectiveSettings,
		connection: connectionIdentityOf(capture.connection),
		loreActivation: capture.plan.loreActivation,
		memoryActivation: capture.plan.memoryActivation,
		provenance: capture.provenance,
		macroPresetId: capture.macroPresetId,
		macroWrites: capture.macroWrites,
	} satisfies Pick<
		AcceptTailGenerationInput,
		"conversationId" | "timestamp" | "humanParticipantId" | "modelParticipantId" |
		"capturedHumanName" | "capturedModelName" | "promptPlan" | "promptInspection" |
		"promptContext" | "generationSettings" | "connection" | "loreActivation" | "memoryActivation" | "provenance" |
		"macroPresetId" | "macroWrites"
	>;
}

/** @approved Build the common provider-neutral request for an accepted Generation.
 * The assistant prefill of a Continuation is request intent, derived from the
 * compiled plan instead of retained separately: the compiler protects the
 * prefixed model entry for an assistant-prefill Continuation, so the plan's
 * final model history block is the prefix and the plan's own intent carries
 * the suffix. */
export function modelRequestFor(
	capture: CapturedGeneration,
	input: Pick<GenerationAttemptInput, "signal">,
): ModelClientGenerationInput {
	const continuationIntent = capture.plan.promptPlan.intent?.type === "continuation"
		? capture.plan.promptPlan.intent
		: undefined;
	return {
		promptPlan: capture.plan.promptPlan,
		modelId: capture.plan.effectiveSettings.modelId,
		generationSettings: projectModelClientGenerationSettings(capture.plan.effectiveSettings),
		connection: capture.connection,
		assistantPrefill: continuationIntent?.strategy === "assistant-prefill"
			? { prefix: finalModelHistoryContent(capture.plan.promptPlan), suffix: continuationIntent.suffix }
			: undefined,
		signal: input.signal,
	};
}

const finalModelHistoryContent = (plan: PromptPlan): string => {
	let content = "";
	for (const block of plan.blocks) {
		if (block.kind === "history" && block.role === "model") content = block.content;
	}
	return content;
};


// @approved
//  Active inspection keeps the exact budget decision made at Generation
// start, including the whole history entries omitted during preflight. The
// retained writing context and the Effective Generation Settings pass
// through as the closed JSON values they already are, and the connection
// identity projection strips the provider snapshot's runtime-only model
// list at the Conversation domain boundary. Inspection is deliberately not
// copied into terminal Variant provenance.
const promptInspectionJson = (budget: PromptBudgetResult): ConversationJsonValue => ({
	tokenEstimate: budget.tokenEstimate,
	responseBudget: budget.responseBudget,
	safetyAllowance: budget.safetyAllowance,
	contextLimit: budget.contextLimit,
	totalRequiredTokens: budget.totalRequiredTokens,
	omittedContext: budget.omittedContext,
});
