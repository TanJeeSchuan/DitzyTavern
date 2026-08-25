import { createDeepSeek } from "@ai-sdk/deepseek";
import { streamText } from "ai";
import type {
	ConnectionProfile,
	ConnectionProfileSecretSnapshot,
} from "../connection-settings/types";
import type { GenerationRequestValue } from "../conversation/types";
import { resolveChatCompletionsRequestUrl } from "../../shared/connection-url";
import type {
	ModelClient,
	ModelClientEvent,
	ModelClientGenerationInput,
} from "./types";
import type { ModelFetch } from "./test-connection";

export interface DeepSeekModelClientOptions {
	readonly profile: ConnectionProfile;
	readonly secrets: ConnectionProfileSecretSnapshot | null;
	readonly fetch?: ModelFetch;
}

export class ModelClientTransportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelClientTransportError";
	}
}

// Production v1 Model Client. The adapter owns all provider request shaping;
// callers only supply the opaque Prompt Plan and provider-neutral generation
// settings. The request destination is captured when this client is created,
// so Profile edits cannot redirect an in-flight Generation.
export function createDeepSeekModelClient(
	options: DeepSeekModelClientOptions,
): ModelClient {
	if (options.profile.apiFormat !== "chat-completions") {
		throw new ModelClientTransportError("The selected API Format is unavailable.");
	}
	if (options.profile.adapter !== "deepseek") {
		throw new ModelClientTransportError(
			`The AI SDK Adapter "${options.profile.adapter}" is unavailable.`,
		);
	}
	const requestUrl = resolveChatCompletionsRequestUrl(options.profile.requestUrl);
	const credential = options.secrets?.credential ?? "";
	const customHeaders = { ...options.secrets?.headers };
	const actualFetch = options.fetch ?? fetch;

	return {
		generate: (input) => generateDeepSeekStream({
			input,
			profile: options.profile,
			credential,
			customHeaders,
			requestUrl,
			actualFetch,
		}),
	};
}

async function* generateDeepSeekStream(options: {
	input: ModelClientGenerationInput;
	profile: ConnectionProfile;
	credential: string;
	customHeaders: Readonly<Record<string, string>>;
	requestUrl: string;
	actualFetch: ModelFetch;
}): AsyncIterable<ModelClientEvent> {
	const modelId = options.input.modelId?.trim() ?? "";
	if (modelId.length === 0) {
		throw new ModelClientTransportError("A model ID is required for Generation.");
	}
	const settings = options.input.generationSettings;
	if (settings === undefined) {
		throw new ModelClientTransportError("Generation settings were not captured.");
	}
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.profile.timeoutMs);
	const fetchAtResolvedDestination = async (_input: RequestInfo | URL, init?: RequestInit) => {
		if (init?.body === undefined) {
			return options.actualFetch(options.requestUrl, { ...init, redirect: "error" });
		}
		// SAFETY: the AI SDK Chat Completions adapter serializes its request body
		// as JSON; the parsed value is constrained to the JSON value domain before
		// the Conversation-owned active-format overrides are merged.
		const providerBody = JSON.parse(String(init.body)) as Record<
			string,
			GenerationRequestValue
		>;
		const overrides = settings.requestOverrides["chat-completions"];
		return options.actualFetch(options.requestUrl, {
			...init,
			body: JSON.stringify({ ...overrides, ...providerBody }),
			redirect: "error",
		});
	};

	try {
		const provider = createDeepSeek({
			// An empty explicit value prevents the SDK from reading a process-wide
			// DEEPSEEK_API_KEY that does not belong to this Profile.
			apiKey: options.credential,
			baseURL: new URL(options.requestUrl).origin,
			headers: options.customHeaders,
			// SAFETY: the AI SDK uses the standard fetch signature; this adapter
			// deliberately pins it to the start-time resolved request URL.
			// SAFETY: the AI SDK invokes only the standard fetch call signature;
			// Bun's optional preconnect helper is not part of this seam.
			fetch: fetchAtResolvedDestination as typeof fetch,
		});
		const streamOptions = {
			model: provider.chat(modelId),
			messages: toMessages(options.input),
			maxRetries: 0,
			abortSignal: controller.signal,
			temperature: settings.temperature ?? undefined,
			topP: settings.topP ?? undefined,
			frequencyPenalty: settings.frequencyPenalty ?? undefined,
			presencePenalty: settings.presencePenalty ?? undefined,
			maxOutputTokens: options.profile.outputTokenRepresentation === "omit"
				? undefined
				: settings.responseBudget,
		};
		const result = streamText(streamOptions);
		for await (const text of result.textStream) {
			if (text.length > 0) yield { type: "content", text };
		}
		const finishReason = await result.finishReason;
		yield { type: "finished", finishReason: normalizeFinishReason(finishReason) };
	} catch (error) {
		if (error instanceof Error) {
			throw new ModelClientTransportError(normalizeTransportError(error));
		}
		throw new ModelClientTransportError("The provider request failed.");
	} finally {
		clearTimeout(timeout);
	}
}

function toMessages(input: ModelClientGenerationInput) {
	const blocks = input.promptPlan.blocks.map((block) => {
		if (block.kind === "history" && block.speakerName !== null) {
			return `${block.speakerName}: ${block.content}`;
		}
		return block.content;
	});
	const content = blocks.filter((block) => block.length > 0).join("\n\n");
	return [{ role: "user" as const, content }];
}

function normalizeFinishReason(value: string | null | undefined): "stop" | "length" | "other" {
	if (value === "stop") return "stop";
	if (value === "length") return "length";
	return "other";
}

function normalizeTransportError(error: Error): string {
	if (error.name === "AbortError") {
		return "The provider did not respond before the Connection Profile timeout.";
	}
	if (error.message.trim().length > 0) {
		return "The provider request failed: an adapter error occurred.";
	}
	return "The provider request failed.";
}
