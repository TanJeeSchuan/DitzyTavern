// Model Client input is one exhaustive named projection of the canonical
// Generation Settings (ADR-0032). The transport seam receives only the
// settings that shape a provider request: the sampling values, the managed
// output limit, and Request Overrides. Every other canonical field stays
// application-owned and is excluded with a stated reason instead of being
// silently dropped, so adding a canonical field fails the adapter until its
// participation at the transport boundary is decided.

import {
	defineGenerationSettingsAdapter,
	type CanonicalGenerationSettings,
	type GenerationSettingsField,
} from "../../shared/contract/generation-settings";

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
			reason: "intent applicability decides the Continuation operands outside transport",
		},
		continuationInstruction: {
			disposition: "excluded",
			reason: "intent applicability decides the Continuation operands outside transport",
		},
		continuationPrefillSuffix: {
			disposition: "excluded",
			reason: "intent applicability decides the Continuation operands outside transport",
		},
		requestOverrides: { disposition: "projected" },
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
// adapter projects, exactly as the canonical declaration states them.
export type ModelClientGenerationSettings = Pick<
	CanonicalGenerationSettings,
	ProjectedModelClientSettingsField
>;

// The per-field projection. Compile-locked: adding a projected canonical
// field fails typecheck until the projection states where it comes from.
type ModelClientSettingsProjection = {
	readonly [K in ProjectedModelClientSettingsField]: (
		settings: CanonicalGenerationSettings,
	) => CanonicalGenerationSettings[K];
};

const projectModelClientSettingsField: ModelClientSettingsProjection = {
	temperature: (settings) => settings.temperature,
	topP: (settings) => settings.topP,
	frequencyPenalty: (settings) => settings.frequencyPenalty,
	presencePenalty: (settings) => settings.presencePenalty,
	contextLimit: (settings) => settings.contextLimit,
	responseBudget: (settings) => settings.responseBudget,
	requestOverrides: (settings) => settings.requestOverrides,
};

// The one named projection producing Model Client input from the complete
// canonical Generation Settings. Send, Continue, and Sibling pass their
// captured settings object through this seam instead of rebuilding
// anonymous field lists at each workflow.
export const projectModelClientGenerationSettings = (
	settings: CanonicalGenerationSettings,
): ModelClientGenerationSettings => ({
	temperature: projectModelClientSettingsField.temperature(settings),
	topP: projectModelClientSettingsField.topP(settings),
	frequencyPenalty: projectModelClientSettingsField.frequencyPenalty(settings),
	presencePenalty: projectModelClientSettingsField.presencePenalty(settings),
	contextLimit: projectModelClientSettingsField.contextLimit(settings),
	responseBudget: projectModelClientSettingsField.responseBudget(settings),
	requestOverrides: projectModelClientSettingsField.requestOverrides(settings),
});
