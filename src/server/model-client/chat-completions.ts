import { streamText } from "ai";
import { getErrorMessage } from "@ai-sdk/provider";
import type {
	ConnectionProfile,
	ConnectionProfileSecretSnapshot,
} from "../connection-settings/types";
import type { GenerationRequestOverrides } from "../conversation/types";
import type { GenerationJsonObject } from "../../shared/generation-provenance";
import { resolveChatCompletionsRequestUrl } from "../../shared/connection-url";
import {
	OUTPUT_LIMIT_CHAT_COMPLETIONS_WIRE_KEYS,
	STRUCTURAL_CHAT_COMPLETIONS_WIRE_KEYS,
} from "../../shared/generation-overrides";
import type {
	ModelClient,
	ModelClientEvent,
	ModelClientGenerationInput,
	ModelClientUsage,
} from "./types";
import { authenticatedHeaders } from "./authenticated-headers";
import type { ModelFetch } from "./model-fetch";
import { createModelAdapter, isModelAdapter } from "./adapter";
import {
	ModelClientTransportError,
	toModelClientTransportError,
} from "./errors";
import {
	formatProviderError,
} from "./provider-errors";
import { monitorSseActivity } from "./sse-activity";

export interface ChatCompletionsModelClientOptions {
	readonly profile: ConnectionProfile;
	readonly secrets: ConnectionProfileSecretSnapshot | null;
	readonly fetch?: ModelFetch;
}

export { ModelClientTransportError } from "./errors";

// ==[HUMAN APPROVED]== Production v1 Model Client. The adapter owns all provider request shaping;
// callers only supply the opaque Prompt Plan and provider-neutral generation
// settings. The request destination is captured when this client is created,
// so Profile edits cannot redirect an in-flight Generation.
export function createDeepSeekModelClient(
	options: ChatCompletionsModelClientOptions,
): ModelClient {
	return createConfiguredModelClient(options, "deepseek");
}

export function createOpenAICompatibleModelClient(
	options: ChatCompletionsModelClientOptions,
): ModelClient {
	return createConfiguredModelClient(options, "openai-compatible");
}

export function createOpenRouterModelClient(
	options: ChatCompletionsModelClientOptions,
): ModelClient {
	return createConfiguredModelClient(options, "openrouter");
}

// ==[HUMAN APPROVED]== The adapter dispatch lives inside the deep Model Client: routes and
// workflows select one provider-neutral factory and never import concrete
// transport constructors.
export function createModelClient(
	options: ChatCompletionsModelClientOptions,
): ModelClient {
	if (!isModelAdapter(options.profile.adapter)) {
		throw new ModelClientTransportError(
			`The AI SDK Adapter "${String(options.profile.adapter)}" is unavailable.`,
			"transport",
		);
	}
	return createConfiguredModelClient(options, options.profile.adapter);
}

function createConfiguredModelClient(
	options: ChatCompletionsModelClientOptions,
	adapter: "deepseek" | "openrouter" | "openai-compatible",
): ModelClient {
	if (options.profile.apiFormat !== "chat-completions") {
		throw new ModelClientTransportError("The selected API Format is unavailable.");
	}
	if (options.profile.adapter !== adapter) {
		throw new ModelClientTransportError(
			`The profile uses ${options.profile.adapter}; expected ${adapter}.`,
		);
	}
	const requestUrl = resolveChatCompletionsRequestUrl(options.profile.requestUrl);
	const credential = options.secrets?.credential ?? "";
	const customHeaders = { ...options.secrets?.headers };
	const actualFetch = options.fetch ?? fetch;

	return {
		generate: (input) => generateOpenAICompatibleStream({
			input,
			profile: options.profile,
			adapter,
			credential,
			customHeaders,
			requestUrl,
			actualFetch,
		}),
	};
}

async function* generateOpenAICompatibleStream(options: {
	input: ModelClientGenerationInput;
	profile: ConnectionProfile;
	adapter: "deepseek" | "openrouter" | "openai-compatible";
	credential: string;
	customHeaders: Readonly<Record<string, string>>;
	requestUrl: string;
	actualFetch: ModelFetch;
}): AsyncIterable<ModelClientEvent> {
	const modelId = options.input.modelId.trim();
	if (modelId.length === 0) {
		throw new ModelClientTransportError("A model ID is required for Generation.");
	}
	const settings = options.input.generationSettings;
	const controller = new AbortController();
	let cancellation: "cancelled" | "inactivity" | null = null;
	let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
	const resetInactivity = () => {
		if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
		if (options.profile.timeoutMs === null || options.profile.timeoutMs <= 0) return;
		inactivityTimer = setTimeout(() => {
			cancellation = "inactivity";
			controller.abort();
		}, options.profile.timeoutMs);
	};
	const onCallerAbort = () => {
		cancellation = "cancelled";
		controller.abort(options.input.signal?.reason);
	};
	if (options.input.signal !== undefined) {
		if (options.input.signal.aborted) onCallerAbort();
		else options.input.signal.addEventListener("abort", onCallerAbort, { once: true });
	}
	resetInactivity();
	// ==[HUMAN APPROVED]== A request without a body carries no Request Overrides to apply and is
	// forwarded to the captured destination unchanged.
	const overriddenBody = (init?: RequestInit): string | undefined => {
		if (init?.body === undefined) return undefined;
		// ==[HUMAN APPROVED]== SAFETY: the AI SDK serializes this request as a JSON object whose values
		// are within the Conversation Request Override JSON domain.
		const providerBody = JSON.parse(String(init.body)) as GenerationRequestOverrides;
		// ==[HUMAN APPROVED]== The Generation Plan Compiler narrowed the Request Overrides to the
		// namespace of the API Format this adapter was constructed for.
		const overrides = settings.requestOverrides;
		validateChatCompletionsOverrides(overrides);
		return JSON.stringify(mergeChatCompletionsOverrides(
			providerBody,
			overrides,
			options.profile.outputTokenRepresentation,
			settings.responseBudget,
		));
	};
	const fetchAtResolvedDestination = async (_input: RequestInfo | URL, init?: RequestInit) => {
		const request: RequestInit = {
			...init,
			headers: authenticatedHeaders(
				init?.headers,
				options.credential.length > 0 ? options.credential : null,
				options.customHeaders,
			),
			redirect: "error",
		};
		const body = overriddenBody(init);
		if (body !== undefined) request.body = body;
		const response = await options.actualFetch(options.requestUrl, request);
		await rejectProviderResponse(response);
		return monitorSseActivity(response, {
			onActivity: resetInactivity,
			signal: controller.signal,
		});
	};

	try {
		const model = createModelAdapter({
			adapter: options.adapter,
			modelId,
			requestUrl: options.requestUrl,
			credential: options.credential,
			headers: options.customHeaders,
			fetch: fetchAtResolvedDestination,
		});
		const streamOptions = {
			model,
			messages: toMessages(options.input),
			maxRetries: 0,
			abortSignal: controller.signal,
			allowSystemInMessages: true,
			temperature: settings.temperature ?? undefined,
			topP: settings.topP ?? undefined,
			frequencyPenalty: settings.frequencyPenalty ?? undefined,
			presencePenalty: settings.presencePenalty ?? undefined,
			maxOutputTokens: settings.responseBudget,
		};
		const result = streamText(streamOptions);
		let finishReason: string | null = null;
		let usageEmitted = false;
		for await (const part of result.fullStream) {
			switch (part.type) {
			case "text-delta":
					if (part.text.length > 0) {
						resetInactivity();
						yield { type: "content", text: part.text };
					}
					break;
				case "reasoning-delta":
					if (part.text.length > 0) {
						resetInactivity();
						yield { type: "reasoning", text: part.text };
					}
					break;
				case "finish-step":
					resetInactivity();
					const stepUsage = normalizeUsage(part.usage);
					if (Object.keys(stepUsage).length > 0) {
						usageEmitted = true;
						yield { type: "usage", usage: stepUsage };
					}
					finishReason = part.finishReason;
					break;
				case "finish":
					resetInactivity();
					finishReason = part.finishReason ?? finishReason;
					break;
				case "abort":
					throw new ModelClientTransportError(
						"The provider stream was aborted before it completed.",
						cancellation ?? "cancelled",
					);
				case "error":
					if (part.error instanceof ModelClientTransportError) throw part.error;
					throw new ModelClientTransportError(
						getErrorMessage(part.error),
						"provider",
					);
				default:
					break;
			}
		}
		const resolvedFinishReason = finishReason ?? await result.finishReason;
		if (!usageEmitted) {
			const usage = await result.usage;
			if (usage !== undefined) {
				const normalizedUsage = normalizeUsage(usage);
				if (Object.keys(normalizedUsage).length > 0) {
					yield { type: "usage", usage: normalizedUsage };
				}
			}
		}
		const normalizedFinishReason = normalizeFinishReason(resolvedFinishReason);
		yield { type: "finished", finishReason: normalizedFinishReason };
	} catch (error) {
		if (cancellation === "inactivity") {
			throw new ModelClientTransportError(
				"The provider stream became inactive before completion.",
				"inactivity",
			);
		}
		if (cancellation === "cancelled") {
			throw new ModelClientTransportError(
				"Generation was cancelled.",
				"cancelled",
			);
		}
		if (error instanceof ModelClientTransportError) throw error;
		throw toModelClientTransportError(error);
	} finally {
		if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
		options.input.signal?.removeEventListener("abort", onCallerAbort);
	}
}

async function rejectProviderResponse(
	response: Response,
): Promise<void> {
	if (response.ok) return;
	const responseBody = await response.text();
	const snapshot = {
		status: response.status,
		contentType: response.headers.get("content-type") ?? undefined,
		bodyBytes: new TextEncoder().encode(responseBody).byteLength,
	};
	throw new ModelClientTransportError(
		formatProviderError(snapshot),
		"provider",
		{ responseBody },
	);
}

// ==[HUMAN APPROVED]== The plan keeps provider-neutral presentation roles; this adapter owns the
// translation into provider vocabulary, exactly as it does for history
// authorship.
const providerRoleFor = {
	system: "system",
	human: "user",
	model: "assistant",
} as const satisfies Record<"system" | "human" | "model", "system" | "user" | "assistant">;

function toMessages(input: ModelClientGenerationInput) {
	type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
	const messages: ChatMessage[] = [];
	const continuationIntent = input.promptPlan.intent?.type === "continuation"
		? input.promptPlan.intent
		: undefined;
	const assistantPrefill = continuationIntent?.strategy === "assistant-prefill";
	if (assistantPrefill && !isPrefillSuffix(continuationIntent.suffix)) {
		throw new ModelClientTransportError(
			"The selected Assistant prefill suffix is unsupported by this adapter.",
			"protocol",
		);
	}
	if (
		assistantPrefill &&
		input.assistantPrefill !== undefined &&
		input.assistantPrefill.suffix !== continuationIntent.suffix
	) {
		throw new ModelClientTransportError(
			"Assistant prefill metadata does not match the selected suffix.",
			"protocol",
		);
	}
	const lastModelHistoryIndex = input.promptPlan.blocks.reduce(
		(last, block, index) => block.kind === "history" && block.role === "model"
			? index
			: last,
		-1,
	);
	let lastModelHistoryContent: string | undefined;
	for (const [blockIndex, block] of input.promptPlan.blocks.entries()) {
		if (block.kind === "history") {
			const role = block.role;
			if (role === "model") {
				lastModelHistoryContent = block.content;
			}
			// ==[HUMAN APPROVED]== The selected preceding model text is moved to the final assistant
			// message below when prefill is active. Leaving the history copy in
			// place would send the prefix twice and would not be a true prefill.
			if (assistantPrefill && blockIndex === lastModelHistoryIndex) {
				continue;
			}
			if (block.content.length > 0) {
				messages.push({
					role: role === "model" ? "assistant" : "user",
					content: block.speakerName === null
						? block.content
						: `${block.speakerName}: ${block.content}`,
				});
			}
			continue;
		}
		if (block.content.length === 0) continue;
		// ==[HUMAN APPROVED]== The compiled presentation role is presentation truth: the recipe
		// slot chose it and the plan kept it provider-neutral, so the adapter
		// owns the same translation it applies to history authorship.
		messages.push({
			role: providerRoleFor[block.role],
			content: block.content,
		});
	}
	// ==[HUMAN APPROVED]== Continuation instructions are request intent, not Conversation history.
	// Keep them as an adapter-owned system message so no synthetic user turn
	// is persisted or inferred by the provider-neutral workflow.
	if (continuationIntent?.strategy === "instruction") {
		if (continuationIntent.instruction.length > 0) {
			messages.push({ role: "system", content: continuationIntent.instruction });
		}
	}
	if (continuationIntent?.strategy === "assistant-prefill") {
		const prefix = input.assistantPrefill?.prefix ?? lastModelHistoryContent;
		if (lastModelHistoryIndex < 0 || prefix === undefined || prefix.length === 0) {
			throw new ModelClientTransportError(
				"Assistant prefill requires a visible preceding model message.",
				"protocol",
			);
		}
		messages.push({
			role: "assistant",
			content: `${prefix}${continuationIntent.suffix}`,
		});
	}
	return messages;
}

function isPrefillSuffix(value: string): value is "" | " " | "\n" | "\n\n" {
	return value === "" || value === " " || value === "\n" || value === "\n\n";
}

const STRUCTURAL_CHAT_COMPLETIONS_FIELDS = new Set<string>(
	STRUCTURAL_CHAT_COMPLETIONS_WIRE_KEYS,
);
const OUTPUT_LIMIT_FIELDS = new Set<string>(OUTPUT_LIMIT_CHAT_COMPLETIONS_WIRE_KEYS);
const UNSUPPORTED_CHAT_COMPLETIONS_FIELDS = new Set([
	"tools",
	"tool_choice",
	"functions",
	"function_call",
	"audio",
	"modalities",
	"images",
	"image",
	"files",
	"input_audio",
]);

function validateChatCompletionsOverrides(
	overrides: GenerationJsonObject,
): void {
	for (const key of Object.keys(overrides)) {
		if (UNSUPPORTED_CHAT_COMPLETIONS_FIELDS.has(key)) {
			throw new ModelClientTransportError(
				`Request Override "${key}" is unsupported by Chat Completions v1.`,
				"protocol",
			);
		}
	}
}

function mergeChatCompletionsOverrides(
	providerBody: GenerationRequestOverrides,
	overrides: GenerationJsonObject,
	outputTokenRepresentation: ConnectionProfile["outputTokenRepresentation"],
	responseBudget: number,
): GenerationRequestOverrides {
	const merged = { ...providerBody };
	for (const [key, value] of Object.entries(overrides)) {
		if (STRUCTURAL_CHAT_COMPLETIONS_FIELDS.has(key) || OUTPUT_LIMIT_FIELDS.has(key)) continue;
		merged[key] = value;
	}
	delete merged.max_tokens;
	delete merged.max_completion_tokens;
	if (outputTokenRepresentation === "automatic" || outputTokenRepresentation === "max_tokens") {
		merged.max_tokens = responseBudget;
	} else if (outputTokenRepresentation === "max_completion_tokens") {
		merged.max_completion_tokens = responseBudget;
	}
	return merged;
}

function normalizeFinishReason(value: string | null | undefined): "stop" | "length" | "other" {
	if (value === "stop") return "stop";
	if (value === "length") return "length";
	return "other";
}

export function normalizeUsage(value: {
	inputTokens?: number | undefined;
	outputTokens?: number | undefined;
	totalTokens?: number | undefined;
}): ModelClientUsage {
	const usage: Record<string, number> = {};
	addUsage(usage, "inputTokens", value.inputTokens);
	addUsage(usage, "outputTokens", value.outputTokens);
	addUsage(usage, "totalTokens", value.totalTokens);
	return usage;
}

function addUsage(target: Record<string, number>, key: string, value: number | undefined): void {
	if (value !== undefined && Number.isFinite(value) && value >= 0) target[key] = value;
}

