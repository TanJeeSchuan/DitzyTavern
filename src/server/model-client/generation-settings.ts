// ==[HUMAN APPROVED]== Model Client input is one exhaustive named projection of the canonical
// Generation Settings (ADR-0032), taken from the attempt's Effective
// Generation Settings. The Generation Plan Compiler already decided intent
// applicability and narrowed Request Overrides to the active API Format, so
// this seam receives exactly the values DitzyTavern supplies to the selected
// Model Client adapter. The remaining canonical fields stay application-owned
// and are never transmitted: model identity rides the Connection Profile
// snapshot, budgeting inputs are consumed by prompt budgeting, concurrency
// policy stays with the application, and the Generation Plan Compiler
// resolves the Continuation operands outside transport.

import type { EffectiveGenerationSettings } from "../generation-plan";

// ==[HUMAN APPROVED]== The canonical fields that cross the transport seam, with the Effective
// values the attempt actually used — Request Overrides arrive as the single
// active-API-Format namespace object. Compile-locked to the Effective
// Generation Settings declaration: an unknown or renamed field fails
// typecheck here.
export type ModelClientGenerationSettings = Pick<
	EffectiveGenerationSettings,
	| "temperature"
	| "topP"
	| "frequencyPenalty"
	| "presencePenalty"
	| "contextLimit"
	| "responseBudget"
	| "requestOverrides"
>;

// ==[HUMAN APPROVED]== The one named projection producing Model Client input from the attempt's
// Effective Generation Settings. Send, Continue, and Sibling pass the
// compiled Generation Plan's effective settings through this seam instead of
// rebuilding anonymous field lists at each workflow.
export const projectModelClientGenerationSettings = (
	effective: EffectiveGenerationSettings,
): ModelClientGenerationSettings => ({
	temperature: effective.temperature,
	topP: effective.topP,
	frequencyPenalty: effective.frequencyPenalty,
	presencePenalty: effective.presencePenalty,
	contextLimit: effective.contextLimit,
	responseBudget: effective.responseBudget,
	requestOverrides: effective.requestOverrides,
});
