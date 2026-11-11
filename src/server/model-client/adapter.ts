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

/** @approved
 * Application adapters become AI SDK providers in this module.
 * Generation and Test Connection both inject their own fetch wrapper while
 * sharing this provider construction and endpoint configuration.
 */
export function createModelAdapter(options: ModelAdapterOptions) {
	const providerOptions = providerSettings(options);

	switch (options.adapter) {
		case "deepseek":
			return createDeepSeek(providerOptions).chat(options.modelId);
		case "openrouter":
			return createOpenRouter({
				...providerOptions,
				// @approved
				//  Strict mode enables OpenRouter usage accounting without adding
				// optional application attribution headers.
				compatibility: "strict",
			}).chat(options.modelId);
		case "openai-compatible":
			return createOpenAICompatible({
				...providerOptions,
				name: "ditzytavern-openai-compatible",
			}).languageModel(options.modelId, { url: () => options.requestUrl });
		default: {
			const _exhaustive: never = options.adapter;
			throw new Error(`Unhandled Model adapter: ${_exhaustive}`);
		}
	}
}

export function isModelAdapter(value: string): value is ModelAdapter {
	return MODEL_ADAPTERS.some((adapter) => adapter === value);
}

const providerSettings = (options: ModelAdapterOptions) => ({
		apiKey: options.credential,
		baseURL: new URL(options.requestUrl).origin,
		headers: options.headers,
		// @approved
		//  SAFETY: the AI SDK invokes the standard Fetch contract at this seam.
		// SAFETY: ModelFetch has the same RequestInfo/RequestInit/Response contract
		// as the AI SDK fetch hook; it only makes the fetch implementation injectable.
		fetch: options.fetch as typeof fetch,
});

export function createImageModelAdapter(options: ModelAdapterOptions & { adapter: Exclude<ModelAdapter, "deepseek"> }) {
	const settings = providerSettings(options);
	return options.adapter === "openrouter"
		? createOpenRouter(settings).imageModel(options.modelId)
		: createOpenAICompatible({ ...settings, name: "ditzytavern-openai-compatible" }).imageModel(options.modelId);
}
