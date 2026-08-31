// Model Client input is one exhaustive named projection of the canonical
// Generation Settings (ADR-0032), taken from the attempt's Effective
// Generation Settings. The Generation Plan Compiler already decided intent
// applicability and narrowed Request Overrides to the active API Format, so
// this seam receives exactly the values DitzyTavern supplies to the selected
// Model Client adapter. Every other canonical field stays application-owned
// and is excluded with a stated reason instead of being silently dropped, so
// adding a canonical field fails the adapter until its participation at the
// transport boundary is decided.

import {
	defineGenerationSettingsAdapter,
	type GenerationSettingsField,
} from "../../shared/contract/generation-settings";
import type { EffectiveGenerationSettings } from "../generation-plan";

// The named Model Client dispositions over the full canonical vocabulary.
export const modelClientGenerationSettingsAdapter = defineGenerationSettingsAdapter(
	"model-client-generation-settings",
	{
		modelId: {
			disposition: "excluded",
			reason: "carried as the Model Client input's own modelId field",
		},
		temperature: { disposition: "projected" },
		topP: { disposition: "projected" },
		frequencyPenalty: { disposition: "projected" },
		presencePenalty: { disposition: "projected" },
		contextLimit: { disposition: "projected" },
		responseBudget: { disposition: "projected" },
		safetyAllowance: {
			disposition: "excluded",
			reason: "consumed by prompt budgeting before the transport seam",
		},
		siblingGenerationLimit: {
			disposition: "excluded",
			reason: "concurrency policy stays with the application",
		},
		continuationStrategy: {
			disposition: "excluded",
			reason: "the Generation Plan Compiler resolves intent applicability outside transport",
		},
		continuationInstruction: {
			disposition: "excluded",
			reason: "the Generation Plan Compiler resolves intent applicability outside transport",
		},
		continuationPrefillSuffix: {
			disposition: "excluded",
			reason: "the Generation Plan Compiler resolves intent applicability outside transport",
		},
		requestOverrides: {
			disposition: "projected",
			// The compiler already narrowed this value to the active API Format
			// namespace; the adapter owns no applicability decision of its own.
		},
	},
);

// The projected canonical vocabulary, derived from the named adapter's own
// dispositions: promoting an excluded field to projected adds it to the
// input type, and a missing disposition fails the adapter first.
type ProjectedModelClientSettingsField = {
	[K in GenerationSettingsField]: (typeof modelClientGenerationSettingsAdapter)["fields"][K] extends {
		readonly disposition: "projected";
	}
		? K
		: never;
}[GenerationSettingsField];

// The Model Client's settings input: exactly the canonical fields the named
// adapter projects, with the Effective values the attempt actually used —
// Request Overrides arrive as the single active-API-Format namespace object.
export type ModelClientGenerationSettings = Pick<
	EffectiveGenerationSettings,
	ProjectedModelClientSettingsField
>;

// The per-field projection. Compile-locked: adding a projected canonical
// field fails typecheck until the projection states where it comes from.
type ModelClientSettingsProjection = {
	readonly [K in ProjectedModelClientSettingsField]: (
		effective: EffectiveGenerationSettings,
	) => EffectiveGenerationSettings[K];
};

const projectModelClientSettingsField: ModelClientSettingsProjection = {
	temperature: (effective) => effective.temperature,
	topP: (effective) => effective.topP,
	frequencyPenalty: (effective) => effective.frequencyPenalty,
	presencePenalty: (effective) => effective.presencePenalty,
	contextLimit: (effective) => effective.contextLimit,
	responseBudget: (effective) => effective.responseBudget,
	requestOverrides: (effective) => effective.requestOverrides,
};

// The one named projection producing Model Client input from the attempt's
// Effective Generation Settings. Send, Continue, and Sibling pass the
// compiled Generation Plan's effective settings through this seam instead of
// rebuilding anonymous field lists at each workflow.
export const projectModelClientGenerationSettings = (
	effective: EffectiveGenerationSettings,
): ModelClientGenerationSettings => ({
	temperature: projectModelClientSettingsField.temperature(effective),
	topP: projectModelClientSettingsField.topP(effective),
	frequencyPenalty: projectModelClientSettingsField.frequencyPenalty(effective),
	presencePenalty: projectModelClientSettingsField.presencePenalty(effective),
	contextLimit: projectModelClientSettingsField.contextLimit(effective),
	responseBudget: projectModelClientSettingsField.responseBudget(effective),
	requestOverrides: projectModelClientSettingsField.requestOverrides(effective),
});
