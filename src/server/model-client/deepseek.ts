import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";
import type {
	ConnectionProfile,
	ConnectionProfileSecretSnapshot,
} from "../connection-settings/types";
import type { GenerationRequestOverrides } from "../conversation/types";
import { resolveChatCompletionsRequestUrl } from "../../shared/connection-url";
import type {
	ModelClient,
	ModelClientEvent,
	ModelClientGenerationInput,
	ModelClientUsage,
} from "./types";
import { authenticatedHeaders } from "./authenticated-headers";
import type { ModelFetch } from "./test-connection";

export interface DeepSeekModelClientOptions {
	readonly profile: ConnectionProfile;
	readonly secrets: ConnectionProfileSecretSnapshot | null;
	readonly fetch?: ModelFetch;
}

export type OpenAICompatibleModelClientOptions = DeepSeekModelClientOptions;

export class ModelClientTransportError extends Error {
	readonly kind: "cancelled" | "inactivity" | "transport" | "provider" | "protocol";

	constructor(
		message: string,
		kind: "cancelled" | "inactivity" | "transport" | "provider" | "protocol" = "transport",
	) {
		super(message);
		this.name = "ModelClientTransportError";
		this.kind = kind;
	}
}

const MAX_PROVIDER_ERROR_BYTES = 16 * 1024;

// Production v1 Model Client. The adapter owns all provider request shaping;
// callers only supply the opaque Prompt Plan and provider-neutral generation
// settings. The request destination is captured when this client is created,
// so Profile edits cannot redirect an in-flight Generation.
export function createDeepSeekModelClient(
	options: DeepSeekModelClientOptions,
): ModelClient {
	return createConfiguredOpenAICompatibleModelClient(options, "deepseek");
}

export function createOpenAICompatibleModelClient(
	options: OpenAICompatibleModelClientOptions,
): ModelClient {
	return createConfiguredOpenAICompatibleModelClient(options, "openai-compatible");
}

function createConfiguredOpenAICompatibleModelClient(
	options: OpenAICompatibleModelClientOptions,
	adapter: "deepseek" | "openai-compatible",
): ModelClient {
	if (options.profile.apiFormat !== "chat-completions") {
		throw new ModelClientTransportError("The selected API Format is unavailable.");
	}
	if (options.profile.adapter !== adapter) {
		throw new ModelClientTransportError(
			`The AI SDK Adapter "${options.profile.adapter}" is unavailable.`,
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
	adapter: "deepseek" | "openai-compatible";
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
	const fetchAtResolvedDestination = async (_input: RequestInfo | URL, init?: RequestInit) => {
		if (init?.body === undefined) {
			const response = await options.actualFetch(options.requestUrl, {
				...init,
					headers: authenticatedHeaders(
						init?.headers,
						options.credential.length > 0 ? options.credential : null,
						options.customHeaders,
					),
				redirect: "error",
			});
			await rejectProviderResponse(response, options.credential, options.customHeaders);
			return monitorResponseActivity(response, resetInactivity, controller.signal);
		}
		// SAFETY: the AI SDK serializes this request as a JSON object whose values
		// are within the Conversation Request Override JSON domain.
		const providerBody = JSON.parse(String(init.body)) as GenerationRequestOverrides;
		const overrides = settings.requestOverrides["chat-completions"] ?? {};
		const requestBody = mergeChatCompletionsOverrides(
			providerBody,
			overrides,
			options.profile.outputTokenRepresentation,
			settings.responseBudget,
		);
		const response = await options.actualFetch(options.requestUrl, {
			...init,
			headers: authenticatedHeaders(
					init.headers,
					options.credential.length > 0 ? options.credential : null,
					options.customHeaders,
				),
			body: JSON.stringify(requestBody),
			redirect: "error",
		});
		await rejectProviderResponse(response, options.credential, options.customHeaders);
		return monitorResponseActivity(response, resetInactivity, controller.signal);
	};

	try {
		const provider = options.adapter === "deepseek"
			? createDeepSeek({
			// An empty explicit value prevents the SDK from reading a process-wide
			// DEEPSEEK_API_KEY that does not belong to this Profile.
			apiKey: options.credential,
			baseURL: new URL(options.requestUrl).origin,
			headers: options.customHeaders,
			// SAFETY: the AI SDK invokes only the standard fetch call signature;
			// Bun's optional preconnect helper is not part of this seam.
			fetch: fetchAtResolvedDestination as typeof fetch,
			})
			: createOpenAI({
				// Generic Profiles are never allowed to inherit OPENAI_API_KEY.
				apiKey: options.credential,
				baseURL: new URL(options.requestUrl).origin,
				headers: options.customHeaders,
				// SAFETY: the AI SDK invokes this standard fetch-compatible function
				// with the same RequestInfo/RequestInit/Response contract.
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
			maxOutputTokens: settings.responseBudget,
		};
		const result = streamText(streamOptions);
		let finishReason: string | null = null;
		let rawFinishReason: string | null = null;
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
					rawFinishReason = boundRawFinishReason(part.rawFinishReason);
					break;
				case "finish":
					resetInactivity();
					finishReason = part.finishReason ?? finishReason;
					rawFinishReason = boundRawFinishReason(part.rawFinishReason) ?? rawFinishReason;
					break;
				case "abort":
					throw new ModelClientTransportError(
						"The provider stream was aborted before it completed.",
						cancellation ?? "cancelled",
					);
				case "error":
					if (part.error instanceof Error) {
						throw normalizeProviderStreamError(
							part.error,
							options.credential,
							options.customHeaders,
						);
					}
					throw new ModelClientTransportError(
						"The provider stream returned an error.",
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
		const normalizedRawFinishReason = rawFinishReason ??
			boundRawFinishReason(await result.rawFinishReason);
		const finishedEvent: ModelClientEvent = normalizedRawFinishReason !== null &&
			normalizedRawFinishReason !== normalizedFinishReason
			? {
				type: "finished",
				finishReason: normalizedFinishReason,
				rawFinishReason: normalizedRawFinishReason,
			}
			: { type: "finished", finishReason: normalizedFinishReason };
		yield finishedEvent;
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
		if (error instanceof Error) {
			throw new ModelClientTransportError(normalizeTransportError(error), "transport");
		}
		throw new ModelClientTransportError("The provider request failed.", "transport");
	} finally {
		if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
		options.input.signal?.removeEventListener("abort", onCallerAbort);
	}
}

async function rejectProviderResponse(
	response: Response,
	credential: string,
	customHeaders: Readonly<Record<string, string>>,
): Promise<void> {
	if (response.ok) return;

	const contentType = response.headers.get("content-type") ?? undefined;
	let body: string | undefined;
	let bodyBytes = 0;
	try {
		const bytes = new Uint8Array(await response.arrayBuffer());
		bodyBytes = bytes.byteLength;
		if (contentType === undefined || isTextualContentType(contentType)) {
			body = new TextDecoder().decode(bytes);
		}
	} catch {
		// The status remains actionable even when the provider error body cannot be read.
	}

	if (contentType !== undefined && !isTextualContentType(contentType)) {
		throw new ModelClientTransportError(
			`The provider returned HTTP ${response.status} with ${contentType} content (${bodyBytes} bytes).`,
			"provider",
		);
	}

	const message = body === undefined ? undefined : extractProviderMessage(body);
	const safeMessage = redactProviderMessage(message ?? body, credential, customHeaders);
	if (safeMessage !== undefined) {
		const bounded = boundProviderMessage(safeMessage);
		throw new ModelClientTransportError(
			`The provider returned HTTP ${response.status}: ${bounded.value}${bounded.truncated ? " (truncated)" : ""}`,
			"provider",
		);
	}
	throw new ModelClientTransportError(
		`The provider request failed with HTTP ${response.status}.`,
		"provider",
	);
}

function normalizeProviderStreamError(
	error: Error,
	credential: string,
	customHeaders: Readonly<Record<string, string>>,
): ModelClientTransportError {
	if (error instanceof ModelClientTransportError) return error;
	// SAFETY: AI SDK provider errors extend Error and expose these optional
	// response fields; only known status/body fields are read below.
	const providerError = error as ProviderStreamError;
	const status = providerError.statusCode ?? providerError.status;
	const body = providerError.responseBody;
	const contentType = readResponseHeader(providerError.responseHeaders, "content-type");
	if (body === undefined && status === undefined) {
		return new ModelClientTransportError("The provider stream returned an error.", "provider");
	}
	const safeMessage = redactProviderMessage(
		body === undefined ? undefined : extractProviderMessage(body) ?? body,
		credential,
		customHeaders,
	);
	if (contentType !== undefined && !isTextualContentType(contentType)) {
		const bytes = body === undefined ? 0 : new TextEncoder().encode(body).byteLength;
		return new ModelClientTransportError(
			`The provider returned HTTP ${status ?? "an error"} with ${contentType} content (${bytes} bytes).`,
			"provider",
		);
	}
	if (safeMessage !== undefined) {
		const bounded = boundProviderMessage(safeMessage);
		return new ModelClientTransportError(
			`The provider returned HTTP ${status ?? "an error"}: ${bounded.value}${bounded.truncated ? " (truncated)" : ""}`,
			"provider",
		);
	}
	return new ModelClientTransportError(
		`The provider request failed${status === undefined ? "." : ` with HTTP ${status}.`}`,
		"provider",
	);
}

interface ConventionalProviderError {
	readonly message?: string;
	readonly detail?: string;
	readonly title?: string;
	readonly error?: ConventionalProviderError;
}

interface ProviderStreamError extends Error {
	readonly statusCode?: number;
	readonly status?: number;
	readonly responseBody?: string;
	readonly responseHeaders?: Readonly<Record<string, string>>;
}

function extractProviderMessage(body: string): string | undefined {
	try {
		// SAFETY: this parser only reads optional conventional provider message fields;
		// the adapter never treats the untrusted body as a transport object.
		const parsed = JSON.parse(body) as ConventionalProviderError | null;
		const message = [
			parsed?.error?.message,
			parsed?.message,
			parsed?.detail,
			parsed?.title,
		].find((candidate) => candidate !== undefined);
		return message?.trim() || undefined;
	} catch {
		return undefined;
	}
}

function redactProviderMessage(
	value: string | undefined,
	credential: string,
	customHeaders: Readonly<Record<string, string>>,
): string | undefined {
	if (value === undefined) return undefined;
	let result = value;
	for (const secret of [credential, ...Object.values(customHeaders)]) {
		if (secret.length > 0) result = result.split(secret).join("[redacted]");
	}
	result = Array.from(result, (character) => {
		const code = character.codePointAt(0) ?? 32;
		return code < 32 || code === 127 ? " " : character;
	}).join("").replace(/\s+/g, " ").trim();
	return result.length === 0 ? undefined : result;
}

interface BoundProviderMessage {
	readonly value: string;
	readonly truncated: boolean;
}

function boundProviderMessage(value: string): BoundProviderMessage {
	let bytes = 0;
	let result = "";
	for (const character of value) {
		const characterBytes = new TextEncoder().encode(character).byteLength;
		if (bytes + characterBytes > MAX_PROVIDER_ERROR_BYTES) {
			return { value: result, truncated: true };
		}
		bytes += characterBytes;
		result += character;
	}
	return { value: result, truncated: false };
}

function isTextualContentType(contentType: string): boolean {
	const normalized = contentType.toLowerCase();
	return normalized.startsWith("text/") || normalized.includes("json") || normalized.includes("xml");
}

function readResponseHeader(
	headers: Readonly<Record<string, string>> | undefined,
	name: string,
): string | undefined {
	if (headers === undefined) return undefined;
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name) return value;
	}
	return undefined;
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

const STRUCTURAL_CHAT_COMPLETIONS_FIELDS = new Set([
	"messages",
	"model",
	"stream",
	"n",
]);
const OUTPUT_LIMIT_FIELDS = new Set(["max_tokens", "max_completion_tokens"]);

function mergeChatCompletionsOverrides(
	providerBody: GenerationRequestOverrides,
	overrides: GenerationRequestOverrides,
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

function normalizeUsage(value: {
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

function boundRawFinishReason(value: string | undefined): string | null {
	if (value === undefined) return null;
	const normalized = Array.from(value, (character) => {
		const code = character.codePointAt(0) ?? 32;
		return code < 32 || code === 127 ? " " : character;
	}).join("").trim();
	return normalized.length === 0 ? null : normalized.slice(0, 128);
}

function monitorResponseActivity(
	response: Response,
	markActivity: () => void,
	abortSignal: AbortSignal,
): Response {
	if (response.body === null) return response;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	const cancelReader = () => {
		void reader.cancel();
	};
	if (abortSignal.aborted) cancelReader();
	else abortSignal.addEventListener("abort", cancelReader, { once: true });
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await reader.read();
				if (next.done) {
					abortSignal.removeEventListener("abort", cancelReader);
					controller.close();
					return;
				}
				pending += decoder.decode(next.value, { stream: true });
				const frames = pending.split(/\r?\n\r?\n/);
				pending = frames.pop() ?? "";
				for (const frame of frames) {
					if (frame.split(/\r?\n/).some((line) => line.trimStart().startsWith(":"))) {
						markActivity();
						continue;
					}
					const data = frame
						.split(/\r?\n/)
						.filter((line) => line.startsWith("data:"))
						.map((line) => line.slice(5).trimStart())
						.join("\n");
					if (data === "[DONE]") {
						markActivity();
						continue;
					}
					try {
						// SAFETY: this is the validated JSON object boundary for SSE activity
						// inspection; AI SDK remains authoritative for actual response parsing.
						const parsed = JSON.parse(data) as ProviderSseFrame;
						const choice = parsed.choices?.[0];
						const delta = choice?.delta;
						if (
							delta?.content !== undefined ||
							delta?.reasoning !== undefined ||
							delta?.reasoning_content !== undefined ||
							parsed.usage !== undefined ||
							choice?.finish_reason !== null && choice?.finish_reason !== undefined
						) {
							markActivity();
						}
					} catch {
						// AI SDK owns malformed-frame handling. Arbitrary or incomplete
						// bytes are deliberately not considered stream activity here.
					}
				}
				controller.enqueue(next.value);
			} catch (error) {
				controller.error(error);
				return;
			}
		},
		cancel(reason) {
			abortSignal.removeEventListener("abort", cancelReader);
			return reader.cancel(reason);
		},
	});
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

interface ProviderSseFrame {
	choices?: Array<{
		delta?: {
			content?: string;
			reasoning?: string;
			reasoning_content?: string;
		};
		finish_reason?: string | null;
	}>;
	usage?: unknown;
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
