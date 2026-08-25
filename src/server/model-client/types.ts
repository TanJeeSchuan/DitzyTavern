// Provider-neutral Model Client contract.
//
// The Prompt Plan crosses this boundary as opaque application input. Provider
// request shapes, credentials, and transport errors belong behind this seam;
// Workflows only consume normalized events.

import type { PromptPlan } from "../prompt-compiler";

export interface ModelClientGenerationInput {
	promptPlan: PromptPlan;
}

export type ModelClientFinishReason = "stop" | "length" | "other";

export type ModelClientEvent =
	| { type: "content"; text: string }
	| { type: "finished"; finishReason: ModelClientFinishReason };

export interface ModelClient {
	generate(input: ModelClientGenerationInput): AsyncIterable<ModelClientEvent>;
}
