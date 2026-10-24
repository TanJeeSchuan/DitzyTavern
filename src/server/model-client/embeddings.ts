import { embeddingResponse, type EmbeddingResponse } from "../../shared/contract/provider-response";
import { Value } from "@sinclair/typebox/value";
import type { ConnectionProfileSecretSnapshot } from "../connection-settings/types";
import { authenticatedHeaders } from "./authenticated-headers";
import { fetchWithTimeout, ModelFetchTimeoutError, readBoundedResponse } from "./model-fetch";
import type { ModelFetch } from "./types";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export type EmbeddingFailureKind = "authentication" | "endpoint" | "timeout" | "malformed-response";

export class EmbeddingServiceError extends Error {
	constructor(readonly kind: EmbeddingFailureKind, message: string) {
		super(message);
		this.name = "EmbeddingServiceError";
	}
}

export interface EmbeddingClientOptions {
	readonly endpoint: string;
	readonly model: string;
	readonly secrets: ConnectionProfileSecretSnapshot | null;
	readonly timeoutMs: number;
	readonly fetch?: ModelFetch;
	readonly signal?: AbortSignal;
}

export async function requestEmbeddings(
	input: readonly string[],
	options: EmbeddingClientOptions,
): Promise<readonly (readonly number[])[]> {
	if (input.length === 0) return [];
	try {
		return await fetchWithTimeout(options.fetch ?? fetch, options.endpoint, {
			method: "POST",
			headers: authenticatedHeaders({ "content-type": "application/json" }, options.secrets?.credential ?? null, options.secrets?.headers ?? {}),
			body: JSON.stringify({ model: options.model, input }),
			redirect: "error",
			signal: options.signal,
		}, options.timeoutMs, async (response, signal) => {
			if (response.status >= 300 && response.status < 400) throw new EmbeddingServiceError("endpoint", "The embedding endpoint redirected the credentialed request.");
			if (response.status === 401 || response.status === 403) throw new EmbeddingServiceError("authentication", "The embedding endpoint rejected the credential.");
			if (!response.ok) throw new EmbeddingServiceError("endpoint", "The embedding endpoint rejected the request.");
			const bounded = await readBoundedResponse(response, MAX_RESPONSE_BYTES, signal);
			if (bounded.truncated) throw new EmbeddingServiceError("malformed-response", "The embedding response is too large to read safely.");
			let parsed: unknown;
			try {
				parsed = JSON.parse(new TextDecoder().decode(bounded.bytes));
			} catch { throw new EmbeddingServiceError("malformed-response", "The embedding endpoint returned invalid JSON."); }
			const vectors = Value.Check(embeddingResponse, parsed) ? parseEmbeddingResponse(parsed) : null;
			if (vectors === null || vectors.length !== input.length) throw new EmbeddingServiceError("malformed-response", "The embedding endpoint returned an unusable vector list.");
			return vectors;
		});
	} catch (error) {
		if (error instanceof EmbeddingServiceError) throw error;
		if (error instanceof ModelFetchTimeoutError || (error instanceof Error && (error.name === "AbortError" || /timeout/i.test(error.message)))) {
			throw new EmbeddingServiceError("timeout", "The embedding endpoint did not respond in time.");
		}
		if (error instanceof Error && /redirect/i.test(error.message)) throw new EmbeddingServiceError("endpoint", "The embedding endpoint redirected the credentialed request.");
		throw new EmbeddingServiceError("endpoint", "The embedding endpoint could not be reached.");
	}
}

function parseEmbeddingResponse(value: EmbeddingResponse): number[][] | null {
	const rows = value.data.map((row) => row.embedding);
	const dimensions = rows[0]?.length;
	return dimensions !== undefined && rows.every((row) => row.length === dimensions) ? rows : null;
}

export const cosineSimilarity = (left: readonly number[], right: readonly number[]): number => {
	if (left.length === 0 || left.length !== right.length) return 0;
	let dot = 0;
	let leftMagnitude = 0;
	let rightMagnitude = 0;
	for (let index = 0; index < left.length; index += 1) {
		const a = left[index] ?? 0;
		const b = right[index] ?? 0;
		dot += a * b;
		leftMagnitude += a * a;
		rightMagnitude += b * b;
	}
	if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
	return dot / Math.sqrt(leftMagnitude * rightMagnitude);
};
