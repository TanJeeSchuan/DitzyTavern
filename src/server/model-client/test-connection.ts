import { createDeepSeek } from "@ai-sdk/deepseek";
import { generateText } from "ai";
import type { ConnectionProfileDraft, ConnectionProfileSecretSnapshot } from "../connection-settings/types";
import { resolveChatCompletionsRequestUrl } from "../../shared/connection-url";

export const TEST_CONNECTION_MAX_OUTPUT_TOKENS = 8;
export const TEST_CONNECTION_TIMEOUT_MS = 10_000;
export const TEST_CONNECTION_PROMPT = "Reply with exactly OK.";
const MAX_PROVIDER_FALLBACK_BYTES = 16 * 1024;

export type TestConnectionFailureKind =
	| "authentication"
	| "endpoint"
	| "timeout"
	| "redirect"
	| "malformed-response"
	| "adapter-unavailable";

export type TestConnectionResult =
	| { outcome: "success"; message: string }
	| {
			outcome: "failure";
			kind: TestConnectionFailureKind;
			message: string;
		};

export interface TestConnectionInput {
	readonly profile: ConnectionProfileDraft;
	readonly modelId: string;
	readonly secrets?: ConnectionProfileSecretSnapshot | null;
	readonly credential?: string | null;
}

export interface TestConnectionOptions {
	readonly fetch?: ModelFetch;
	readonly timeoutMs?: number;
	readonly maxOutputTokens?: number;
}

export type ModelFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function resolveTestConnectionBackend(
	modelBackend: ConnectionProfileDraft["modelBackend"],
): "ai-sdk" {
	if (modelBackend === "automatic" || modelBackend === "ai-sdk") return "ai-sdk";
	throw new Error(`The Model Backend "${modelBackend}" is unavailable.`);
}

export async function testDeepSeekConnection(
	input: TestConnectionInput,
	options: TestConnectionOptions = {},
): Promise<TestConnectionResult> {
	const modelId = input.modelId.trim();
	if (modelId.length === 0) {
		return failure("endpoint", "A model ID is required to test the Connection Profile.");
	}
	if (input.profile.apiFormat !== "chat-completions") {
		return failure("adapter-unavailable", "The selected API Format is unavailable.");
	}
	try {
		resolveTestConnectionBackend(input.profile.modelBackend);
	} catch (error) {
		return failure(
			"adapter-unavailable",
			error instanceof Error ? error.message : "The selected Model Backend is unavailable.",
		);
	}
	if (input.profile.adapter !== "deepseek") {
		return failure(
			"adapter-unavailable",
			`The AI SDK Adapter "${input.profile.adapter}" is unavailable for Test Connection.`,
		);
	}

	let requestUrl: string;
	try {
		requestUrl = resolveChatCompletionsRequestUrl(input.profile.requestUrl);
	} catch (error) {
		return failure(
			"endpoint",
			error instanceof Error ? error.message : "The request URL could not be resolved.",
		);
	}

	const credential = input.credential !== undefined
		? input.credential
		: input.secrets?.credential ?? null;
	const headers = { ...input.secrets?.headers };
	const profileTimeoutMs = input.profile.timeoutMs ?? TEST_CONNECTION_TIMEOUT_MS;
	const timeoutMs = Math.max(
			1,
			Math.min(profileTimeoutMs, options.timeoutMs ?? TEST_CONNECTION_TIMEOUT_MS),
		);
	const controller = new AbortController();
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const actualFetch = options.fetch ?? fetch;
	const fetchAtResolvedDestination: ModelFetch = async (_input, init) =>
		actualFetch(requestUrl, {
			...init,
			redirect: "error",
		});

	try {
		const provider = createDeepSeek({
			// An empty explicit value prevents the SDK from reading a process-wide
			// DEEPSEEK_API_KEY that does not belong to this Profile.
			apiKey: credential ?? "",
			baseURL: new URL(requestUrl).origin,
			headers,
			// SAFETY: the AI SDK invokes only the standard fetch call signature;
			// Bun's optional preconnect helper is not part of the provider contract.
			fetch: fetchAtResolvedDestination as typeof fetch,
		});
		const result = await generateText({
			model: provider.chat(modelId),
			prompt: TEST_CONNECTION_PROMPT,
			maxOutputTokens: options.maxOutputTokens ?? TEST_CONNECTION_MAX_OUTPUT_TOKENS,
			maxRetries: 0,
			abortSignal: controller.signal,
		});
		if (result.text.trim().length === 0) {
			return failure("malformed-response", "The provider returned no text for the test response.");
		}
		return { outcome: "success", message: "Connection succeeded. The provider answered the test request." };
	} catch (error) {
		if (!(error instanceof Error)) {
			return failure("endpoint", "The provider request failed.");
		}
		// SAFETY: AI SDK provider failures extend Error and expose these optional
		// response fields; the parser below reads only those known fields.
		return normalizeTestConnectionError(error as ProviderError, {
			timedOut,
			credential,
			headers,
		});
	} finally {
		clearTimeout(timeout);
	}
}

interface ErrorContext {
	timedOut: boolean;
	credential: string | null;
	headers: Readonly<Record<string, string>>;
}

interface ProviderError extends Error {
	readonly cause?: Error;
	readonly statusCode?: number;
	readonly status?: number;
	readonly responseBody?: string;
	readonly responseHeaders?: Readonly<Record<string, string>>;
}

interface ConventionalErrorBody {
	readonly message?: string;
	readonly detail?: string;
	readonly title?: string;
	readonly error?: ConventionalErrorBody;
}

function normalizeTestConnectionError(
	error: ProviderError,
	context: ErrorContext,
): TestConnectionResult {
	if (context.timedOut || isAbortError(error)) {
		return failure("timeout", "The provider did not respond within the short Test Connection timeout.");
	}
	const status = readNumber(error, "statusCode") ?? readNumber(error, "status");
	if (status !== undefined && status >= 300 && status < 400) {
		return failure("redirect", "The provider redirected the credentialed request, so it was not followed.");
	}
	if (status === 401 || status === 403) {
		return failure("authentication", providerFailureMessage(error, status, context));
	}
	if (isMalformedResponseError(error)) {
		return failure("malformed-response", providerFailureMessage(error, status, context));
	}
	if (isRedirectError(error)) {
		return failure("redirect", "The provider redirected the credentialed request, so it was not followed.");
	}
	return failure("endpoint", providerFailureMessage(error, status, context));
}

function providerFailureMessage(
	error: ProviderError,
	status: number | undefined,
	context: ErrorContext,
): string {
	const contentType = readHeader(error, "content-type");
	const body = readString(error, "responseBody");
	if (contentType !== undefined && !isTextualContentType(contentType)) {
		const bytes = body === undefined ? 0 : new TextEncoder().encode(body).byteLength;
		return `The provider returned HTTP ${status ?? "an error"} with ${contentType} content (${bytes} bytes).`;
	}
	const conventional = body === undefined ? undefined : extractConventionalMessage(body);
	const fallback = conventional ?? body;
	if (fallback !== undefined && fallback.length > 0) {
		const safe = redactSensitive(fallback, context);
		const bounded = safe.slice(0, MAX_PROVIDER_FALLBACK_BYTES);
		return `The provider returned HTTP ${status ?? "an error"}: ${bounded}${safe.length > MAX_PROVIDER_FALLBACK_BYTES ? " (truncated)" : ""}`;
	}
	return `The provider request failed${status === undefined ? "." : ` with HTTP ${status}.`}`;
}

function extractConventionalMessage(body: string): string | undefined {
	try {
		// SAFETY: provider error bodies use this conventional nested message
		// shape; optional chaining safely ignores other JSON shapes.
		const parsed = JSON.parse(body) as ConventionalErrorBody | null;
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

function redactSensitive(value: string, context: ErrorContext): string {
	let result = value;
	for (const secret of [context.credential, ...Object.values(context.headers)]) {
		if (secret !== null && secret.length > 0) result = result.split(secret).join("[redacted]");
	}
	return result.replace(/\s+/g, " ").trim();
}

function isTextualContentType(contentType: string): boolean {
	const normalized = contentType.toLowerCase();
	return normalized.startsWith("text/") || normalized.includes("json") || normalized.includes("xml");
}

function isMalformedResponseError(error: ProviderError): boolean {
	const name = `${error.name} ${error.cause?.name ?? ""}`.toLowerCase();
	return name.includes("jsonparse") || name.includes("invalidresponsedata") || name.includes("emptyresponse");
}

function isRedirectError(error: ProviderError): boolean {
	const message = safeErrorMessage(error).toLowerCase();
	return message.includes("redirect") || message.includes("maximum redirect");
}

function isAbortError(error: ProviderError): boolean {
	return error.name === "AbortError";
}

function readString(value: ProviderError, key: "responseBody"): string | undefined {
	return key === "responseBody" ? value.responseBody : undefined;
}

function readNumber(value: ProviderError, key: "statusCode" | "status"): number | undefined {
	return key === "statusCode" ? value.statusCode : value.status;
}

function readHeader(value: ProviderError, name: "content-type"): string | undefined {
	const headers = value.responseHeaders;
	if (headers === undefined) return undefined;
	for (const [key, headerValue] of Object.entries(headers)) {
		if (key.toLowerCase() === name) return headerValue;
	}
	return undefined;
}

function safeErrorMessage(error: ProviderError): string {
	return error.message;
}

function failure(kind: TestConnectionFailureKind, message: string): TestConnectionResult {
	return { outcome: "failure", kind, message };
}
