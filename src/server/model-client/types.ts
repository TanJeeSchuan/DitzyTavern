// Provider-neutral Model Client contract.
//
// The Prompt Plan crosses this boundary as opaque application input. Provider
// request shapes, credentials, and transport errors belong behind this seam;
// Workflows only consume normalized events.

import type { PromptPlan } from "../prompt-compiler";
import type { GenerationRequestOverrides } from "../conversation/types";

export interface ModelClientGenerationInput {
	promptPlan: PromptPlan;
	// Conversation-owned values are captured once by the Generation workflow
	// and travel with the opaque Prompt Plan into the transport seam.
	modelId?: string;
	generationSettings?: ModelClientGenerationSettings;
	connection?: ModelClientConnectionSnapshot | null;
}

export interface ModelClientGenerationSettings {
	temperature: number | null;
	topP: number | null;
	frequencyPenalty: number | null;
	presencePenalty: number | null;
	contextLimit: number;
	responseBudget: number;
	requestOverrides: Readonly<Record<string, GenerationRequestOverrides>>;
}

// Safe connection identity only. URLs, credentials, and custom header values
// are intentionally absent so this shape is safe for events and provenance.
export interface ModelClientConnectionSnapshot {
	profileId: number;
	settingsRevision: number;
	backend: string;
	adapter: string;
}

export type ModelClientFinishReason = "stop" | "length" | "other";

export type ModelClientEvent =
	| { type: "content"; text: string }
	| { type: "finished"; finishReason: ModelClientFinishReason };

export interface ModelClient {
	generate(input: ModelClientGenerationInput): AsyncIterable<ModelClientEvent>;
}
