import { generateText } from "ai";
import type { ConnectionProfileDraft, ConnectionProfileSecretSnapshot } from "../connection-settings/types";
import { resolveChatCompletionsRequestUrl, resolveEmbeddingsRequestUrl } from "../../shared/connection-url";
import { EmbeddingServiceError, requestEmbeddings } from "./embeddings";
import { authenticatedHeaders } from "./authenticated-headers";
import { decisionRequest, requestDecisions, resolveDecisionProfile } from "../decision-model";
import { createModelAdapter, isModelAdapter } from "./adapter";
import type { ModelFetch } from "./model-fetch";
import { ModelFetchTimeoutError } from "./model-fetch";
import { readProviderDiagnostic, redactProviderDiagnostic } from "./diagnostics";
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
			responseBody?: string;
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

export async function testConnection(
	input: TestConnectionInput,
	options: TestConnectionOptions = {},
): Promise<TestConnectionResult> {
	const modelId = input.modelId.trim();
	if (modelId.length === 0) {
		return failure("endpoint", "A model ID is required to test the Connection Profile.");
	}
	if (input.profile.apiFormat === "embeddings") return testEmbeddings(input.profile, modelId, input.secrets ?? null, options);
	if (input.profile.apiFormat === "system-one") {
		try {
			const selection = resolveDecisionProfile(input.profile, modelId, 16_000, input.secrets ?? null);
			const { request } = decisionRequest(selection, "ping", { ping: { type: "noul", instructions: "Is the state ping?" } });
			await requestDecisions({ request, selection, fetch: options.fetch });
			return { outcome: "success", message: "Connection succeeded. The Decision Model answered the test question." };
		} catch (error) {
			return failure(error instanceof ModelFetchTimeoutError ? "timeout" : "malformed-response", error instanceof Error ? error.message : "The Decision Model test failed.");
		}
	}
	if (input.profile.apiFormat !== "chat-completions") {
		return failure("adapter-unavailable", "The selected API Format is unavailable.");
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
	const secretValues = [credential ?? "", ...Object.values(headers)];
	const fetchAtResolvedDestination: ModelFetch = async (_input, init) => {
		const response = await actualFetch(requestUrl, {
			...init,
			headers: authenticatedHeaders(init?.headers, credential, headers),
			redirect: "error",
		});
		if (response.ok) return response;
		return new Response(await readProviderDiagnostic(response, secretValues), {
			status: response.status,
			headers: { "content-type": response.headers.get("content-type") ?? "text/plain" },
		});
	};

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
		if (result.text.trim().length === 0 && !hasReasoning(result)) {
			return failure("malformed-response", "The provider returned no text for the test response.");
		}
		return { outcome: "success", message: "Connection succeeded. The provider answered the test request." };
	} catch (error) {
		if (!(error instanceof Error)) {
			return failure("endpoint", "The provider request failed.");
		}
		// SAFETY: AI SDK provider failures extend Error and expose these optional
		// response fields; the parser below reads only those known fields. ==[HUMAN APPROVED]==
		return normalizeTestConnectionError(error as ProviderErrorLike, {
			timedOut,
			secretValues,
		});
	} finally {
		clearTimeout(timeout);
	}
}

async function testEmbeddings(
	profile: ConnectionProfileDraft,
	modelId: string,
	secrets: ConnectionProfileSecretSnapshot | null,
	options: TestConnectionOptions,
): Promise<TestConnectionResult> {
	try {
		const vectors = await requestEmbeddings(["DitzyTavern embedding test"], {
			endpoint: resolveEmbeddingsRequestUrl(profile.requestUrl),
			model: modelId,
			secrets,
			timeoutMs: Math.min(profile.timeoutMs ?? TEST_CONNECTION_TIMEOUT_MS, options.timeoutMs ?? TEST_CONNECTION_TIMEOUT_MS),
			fetch: options.fetch,
		});
		return { outcome: "success", message: `Connection succeeded. The endpoint returned ${vectors[0]?.length ?? 0}-dimension vectors.` };
	} catch (error) {
		if (error instanceof EmbeddingServiceError) return failure(error.kind, error.message);
		return failure("endpoint", error instanceof Error ? error.message : "The embedding request failed.");
	}
}

interface ErrorContext {
	timedOut: boolean;
	secretValues: readonly string[];
}

function normalizeTestConnectionError(
	error: ProviderErrorLike,
	context: ErrorContext,
): TestConnectionResult {
	if (context.timedOut || isAbortError(error)) {
		return failure("timeout", "The provider did not respond within the short Test Connection timeout.");
	}
	const status = providerErrorStatus(error);
	const responseBody = error.responseBody === undefined ? undefined : redactProviderDiagnostic(error.responseBody, context.secretValues);
	if (status !== undefined && status >= 300 && status < 400) {
		return failure("redirect", "The provider redirected the credentialed request, so it was not followed.");
	}
	if (status === 401 || status === 403) {
		return failure("authentication", providerFailureMessage(error), responseBody);
	}
	if (isMalformedResponseError(error)) {
		return failure("malformed-response", providerFailureMessage(error), responseBody);
	}
	if (isRedirectError(error)) {
		return failure("redirect", "The provider redirected the credentialed request, so it was not followed.");
	}
	return failure("endpoint", providerFailureMessage(error), responseBody);
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

function hasReasoning(result: { reasoningText?: string | undefined; reasoning: Array<{ type: string; text?: string | undefined }> }): boolean {
	if ((result.reasoningText ?? "").trim().length > 0) return true;
	return result.reasoning.some((part) => part.type === "reasoning" && (part.text ?? "").trim().length > 0);
}

function failure(kind: TestConnectionFailureKind, message: string, responseBody?: string): TestConnectionResult {
	const result: TestConnectionResult = { outcome: "failure", kind, message };
	if (responseBody !== undefined) result.responseBody = responseBody;
	return result;
}
