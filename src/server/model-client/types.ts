// Provider-neutral Model Client contract.
//
// The Prompt Plan crosses this boundary as opaque application input. Provider
// request shapes, credentials, and transport errors belong behind this seam;
// Workflows only consume normalized events.
//
// Normalized events are the shared Generation event vocabulary
// (src/shared/contract/generation-events): the same schema-owned union the
// SSE seam publishes and every client decodes, so the Model Client, the
// server, and the client can never drift into parallel shape declarations.
import type { PromptPlan } from "../prompt-compiler";
import type { GenerationRequestOverrides } from "../conversation/types";
import type {
	GenerationEvent,
	GenerationFailureKind,
	GenerationFinishReason,
	GenerationUsage,
} from "../../shared/contract/generation-events";

export type ModelClientEvent = GenerationEvent;
export type ModelClientUsage = GenerationUsage;
export type ModelClientFinishReason = GenerationFinishReason;
export type ModelClientFailureKind = GenerationFailureKind;

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
	// Request-only assistant prefill. The prefix is copied from the selected
	// preceding model Variant and is never persisted as part of the new
	// continuation Message. Adapters that support prefill place this in their
	// provider-specific assistant-prefix position.
	assistantPrefill?: AssistantPrefill | undefined;
	connection?: ModelClientConnectionSnapshot | null;
	// A caller-owned signal targets only this Generation. The transport must
	// never reuse it for another request or turn cancellation into retry.
	signal?: AbortSignal;
}

export interface AssistantPrefill {
	readonly prefix: string;
	readonly suffix: "" | " " | "\n" | "\n\n";
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

export interface ModelClient {
	generate(input: ModelClientGenerationInput): AsyncIterable<ModelClientEvent>;
}
