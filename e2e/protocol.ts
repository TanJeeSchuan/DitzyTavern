import { Type, type Static } from "@sinclair/typebox";
import type { DecisionAnswer } from "../src/shared/contract/decision-model";
import type { BuildMetadata } from "../src/server/build-metadata";

export type RegistryReply = { buildNumber: number; revision: string; hold?: boolean } | { status: number };
export type UpdateScenario = { build: BuildMetadata; automaticChecks?: boolean; replies: RegistryReply[] };

export type ChatReply =
	| { chunks: string[]; hold?: boolean; truncate?: boolean; repeat?: boolean }
	| { status: number; error: string; hold?: boolean; repeat?: boolean };

// @approved
// `passage`, when given, must also appear in a World Clock digest's passage.
// `hold` parks the answer until the test releases the fake.
export type DecisionRule = ({ match: string[]; answer: DecisionAnswer } | { match: string[]; status: number }) & { passage?: string; hold?: boolean };

export type MemoryClaim = { claim: string; attribution: string; people: string[]; excerpt: string };

// @approved
// Provider request bodies the fake answers. The fake decodes each intercepted
// call with these schemas before handing it to its kind-specific reply, so no
// unparsed provider JSON reaches the reply logic or the call log.
const chatCompletionMessage = Type.Object({ role: Type.String(), content: Type.String() });
export const chatCompletionCallBody = Type.Object({
	model: Type.String(),
	// @approved
	// Test Connection uses generateText, which omits `stream`; a Generation
	// streams and sends true. Absent is a valid non-streaming request.
	stream: Type.Optional(Type.Boolean()),
	messages: Type.Array(chatCompletionMessage),
});
export type ChatCompletionCallBody = Static<typeof chatCompletionCallBody>;

export const decisionCallBody = Type.Object({
	model: Type.String(),
	state: Type.Unknown(),
	questions: Type.Record(Type.String(), Type.Unknown()),
});
export type DecisionCallBody = Static<typeof decisionCallBody>;

/** @approved A Decision call's state is a provider-defined object, a string for the Test Connection ping, or absent. */
export const hasDecisionPassage = (state: unknown): state is { readonly passage: unknown } =>
	typeof state === "object" && state !== null && "passage" in state;

export const embeddingsCallBody = Type.Object({
	input: Type.Union([Type.String(), Type.Array(Type.String())]),
});
export type EmbeddingsCallBody = Static<typeof embeddingsCallBody>;

export type ChatModelCall = { kind: "chat" | "extraction"; url: string; headers: Record<string, string>; body: ChatCompletionCallBody };
export type DecisionModelCall = { kind: "decision"; url: string; headers: Record<string, string>; body: DecisionCallBody };
export type EmbeddingsModelCall = { kind: "embeddings"; url: string; headers: Record<string, string>; body: EmbeddingsCallBody };
export type UncategorizedModelCall = { kind: "models" | "unknown"; url: string; headers: Record<string, string>; body: unknown };
export type ModelCall = ChatModelCall | DecisionModelCall | EmbeddingsModelCall | UncategorizedModelCall;

/** @approved Narrow logged calls by their decoded kind; the raw `kind` string on an old log entry is untyped. */
export const isChatModelCall = (call: ModelCall): call is ChatModelCall => call.kind === "chat";
export const isDecisionModelCall = (call: ModelCall): call is DecisionModelCall => call.kind === "decision";
/** @approved The first logged call `accepts` picks; it throws when the fake received none, so a test reading it fails at the cause. */
export const firstCall = <Call extends ModelCall>(calls: readonly ModelCall[], accepts: (call: ModelCall) => call is Call): Call => {
	const call = calls.find(accepts);
	if (call === undefined) throw new Error("The fake received no matching model call.");
	return call;
};
