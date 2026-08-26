// Provider-neutral Model Client contract.
//
// The Prompt Plan crosses this boundary as opaque application input. Provider
// request shapes, credentials, and transport errors belong behind this seam;
// Workflows only consume normalized events.

import type { PromptPlan } from "../prompt-compiler";
import type { GenerationRequestOverrides } from "../conversation/types";

export interface ModelClientGenerationInput {
	promptPlan: PromptPlan;
	// The compiler keeps the plan provider-neutral. These role hints preserve
	// historical authorship without making the transport depend on domain
	// Participant objects or provider message types.
	historyRoles: readonly ("human" | "model" | null)[];
	// Conversation-owned values are captured once by the Generation workflow
	// and travel with the opaque Prompt Plan into the transport seam.
	modelId: string;
	generationSettings: ModelClientGenerationSettings;
	connection?: ModelClientConnectionSnapshot | null;
	// A caller-owned signal targets only this Generation. The transport must
	// never reuse it for another request or turn cancellation into retry.
	signal?: AbortSignal;
}

export type ModelFetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

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

export interface ModelClientUsage {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly totalTokens?: number;
}

export type ModelClientFailureKind =
	| "cancelled"
	| "inactivity"
	| "transport"
	| "provider"
	| "protocol";

export type ModelClientEvent =
	| { type: "content"; text: string }
	| { type: "reasoning"; text: string }
	| { type: "usage"; usage: ModelClientUsage }
	| { type: "keepalive" }
	| {
			type: "finished";
			finishReason: ModelClientFinishReason;
			rawFinishReason?: string;
	  }
	| { type: "failed"; kind: ModelClientFailureKind; message: string };

export interface ModelClient {
	generate(input: ModelClientGenerationInput): AsyncIterable<ModelClientEvent>;
}
