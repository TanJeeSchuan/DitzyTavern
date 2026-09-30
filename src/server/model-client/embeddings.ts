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
			let parsed: JsonValue;
			try {
				// ==[HUMAN APPROVED]== SAFETY: parseEmbeddingResponse validates the untrusted JSON shape before use.
				parsed = JSON.parse(new TextDecoder().decode(bounded.bytes)) as JsonValue;
			} catch { throw new EmbeddingServiceError("malformed-response", "The embedding endpoint returned invalid JSON."); }
			const vectors = parseEmbeddingResponse(parsed);
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

type JsonValue = string | number | boolean | null | JsonValue[] | { readonly [key: string]: JsonValue };
type JsonObject = { readonly [key: string]: JsonValue };

function parseEmbeddingResponse(value: JsonValue): number[][] | null {
	if (!isObject(value) || !Array.isArray(value.data)) return null;
	const rows = value.data.flatMap((row) => {
		if (!isObject(row) || !Array.isArray(row.embedding)) return [];
		if (!row.embedding.every(isFiniteNumber)) return [];
		// ==[HUMAN APPROVED]== SAFETY: every value passed this guard's number tag and finite-value check.
		return [row.embedding as number[]];
	});
	if (rows.length !== value.data.length || rows.some((row) => row.length === 0)) return null;
	const dimensions = rows[0]?.length;
	return dimensions !== undefined && rows.every((row) => row.length === dimensions) ? rows : null;
}

function isObject(value: JsonValue): value is JsonObject {
	return Object.prototype.toString.call(value) === "[object Object]";
}

function isFiniteNumber(value: JsonValue): value is number {
	if (Object.prototype.toString.call(value) !== "[object Number]") return false;
	// ==[HUMAN APPROVED]== SAFETY: the number tag above narrows this JSON value to a number.
	return Number.isFinite(value as number);
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
