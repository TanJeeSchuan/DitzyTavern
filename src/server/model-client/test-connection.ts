import { generateText } from "ai";
import type { ConnectionProfileDraft, ConnectionProfileSecretSnapshot } from "../connection-settings/types";
import { resolveChatCompletionsRequestUrl } from "../../shared/connection-url";
import { authenticatedHeaders } from "./authenticated-headers";
import { createModelAdapter, isModelAdapter } from "./adapter";
import type { ModelFetch } from "./model-fetch";
import {
	formatProviderError,
	providerErrorStatus,
	snapshotProviderError,
	type ProviderErrorLike,
} from "./provider-errors";

export const TEST_CONNECTION_MAX_OUTPUT_TOKENS = 8;
export const TEST_CONNECTION_TIMEOUT_MS = 10_000;
export const TEST_CONNECTION_PROMPT = "Reply with exactly OK.";

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
}

export interface TestConnectionOptions {
	readonly fetch?: ModelFetch;
	readonly timeoutMs?: number;
	readonly maxOutputTokens?: number;
}

export function resolveTestConnectionBackend(
	modelBackend: ConnectionProfileDraft["modelBackend"],
): "ai-sdk" {
	if (modelBackend === "automatic" || modelBackend === "ai-sdk") return "ai-sdk";
	throw new Error(`The Model Backend "${modelBackend}" is unavailable.`);
}

export async function testConnection(
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
	if (!isModelAdapter(input.profile.adapter)) {
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

	const credential = input.secrets?.credential ?? null;
	const headers = { ...input.secrets?.headers };
	const profileTimeoutMs = input.profile.timeoutMs !== null && input.profile.timeoutMs > 0
		? input.profile.timeoutMs
		: TEST_CONNECTION_TIMEOUT_MS;
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
			headers: authenticatedHeaders(init?.headers, credential, headers),
			redirect: "error",
		});

	try {
		const provider = createModelAdapter({
			adapter: input.profile.adapter,
			modelId,
			requestUrl,
			credential: credential ?? "",
			headers,
			fetch: fetchAtResolvedDestination,
		});
		const result = await generateText({
			model: provider,
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
		return normalizeTestConnectionError(error as ProviderErrorLike, {
			timedOut,
		});
	} finally {
		clearTimeout(timeout);
	}
}

interface ErrorContext {
	timedOut: boolean;
}

function normalizeTestConnectionError(
	error: ProviderErrorLike,
	context: ErrorContext,
): TestConnectionResult {
	if (context.timedOut || isAbortError(error)) {
		return failure("timeout", "The provider did not respond within the short Test Connection timeout.");
	}
	const status = providerErrorStatus(error);
	if (status !== undefined && status >= 300 && status < 400) {
		return failure("redirect", "The provider redirected the credentialed request, so it was not followed.");
	}
	if (status === 401 || status === 403) {
		return failure("authentication", providerFailureMessage(error));
	}
	if (isMalformedResponseError(error)) {
		return failure("malformed-response", providerFailureMessage(error));
	}
	if (isRedirectError(error)) {
		return failure("redirect", "The provider redirected the credentialed request, so it was not followed.");
	}
	return failure("endpoint", providerFailureMessage(error));
}

function providerFailureMessage(error: ProviderErrorLike): string {
	return formatProviderError(
		snapshotProviderError(error),
	);
}

function isMalformedResponseError(error: ProviderErrorLike): boolean {
	const name = `${error.name} ${error.cause?.name ?? ""}`.toLowerCase();
	return name.includes("jsonparse") || name.includes("invalidresponsedata") || name.includes("emptyresponse");
}

function isRedirectError(error: ProviderErrorLike): boolean {
	const message = error.message.toLowerCase();
	return message.includes("redirect") || message.includes("maximum redirect");
}

function isAbortError(error: ProviderErrorLike): boolean {
	return error.name === "AbortError";
}

function failure(kind: TestConnectionFailureKind, message: string): TestConnectionResult {
	return { outcome: "failure", kind, message };
}
