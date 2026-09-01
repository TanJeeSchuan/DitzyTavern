import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { ModelFetch } from "./model-fetch";

export const MODEL_ADAPTERS = [
	"deepseek",
	"openrouter",
	"openai-compatible",
] as const;

export type ModelAdapter = (typeof MODEL_ADAPTERS)[number];

export interface ModelAdapterOptions {
	readonly adapter: ModelAdapter;
	readonly modelId: string;
	readonly requestUrl: string;
	readonly credential: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly fetch: ModelFetch;
}

/**
 * ==[HUMAN APPROVED]== The only place where an application adapter becomes an AI SDK provider.
 * Generation and Test Connection both inject their own fetch wrapper while
 * sharing this provider construction and endpoint configuration.
 */
export function createModelAdapter(options: ModelAdapterOptions) {
	const providerOptions = {
		apiKey: options.credential,
		baseURL: new URL(options.requestUrl).origin,
		headers: options.headers,
		// ==[HUMAN APPROVED]== SAFETY: the AI SDK invokes the standard Fetch contract at this seam.
		// SAFETY: ModelFetch has the same RequestInfo/RequestInit/Response contract
		// as the AI SDK fetch hook; it only makes the fetch implementation injectable.
		fetch: options.fetch as typeof fetch,
	};

	switch (options.adapter) {
		case "deepseek":
			return createDeepSeek(providerOptions).chat(options.modelId);
		case "openrouter":
			return createOpenRouter({
				...providerOptions,
				// ==[HUMAN APPROVED]== Strict mode enables OpenRouter usage accounting without adding
				// optional application attribution headers.
				compatibility: "strict",
			}).chat(options.modelId);
		case "openai-compatible":
			return createOpenAICompatible({
				...providerOptions,
				name: "ditzytavern-openai-compatible",
			}).languageModel(options.modelId, { url: () => options.requestUrl });
	}
}

export function isModelAdapter(value: string): value is ModelAdapter {
	return MODEL_ADAPTERS.some((adapter) => adapter === value);
}
