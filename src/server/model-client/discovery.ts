import type {
	ConnectionProfileDraft,
	ConnectionProfileSecretSnapshot,
} from "../connection-settings/types";
import { authenticatedHeaders } from "./authenticated-headers";
import type { ModelFetch } from "./model-fetch";
import { fetchWithTimeout, ModelFetchTimeoutError, readBoundedResponse } from "./model-fetch";
import { formatProviderError, snapshotProviderResponse } from "./provider-errors";
import { compareModelIds } from "../../shared/model-identifier";

const MAX_DISCOVERY_RESPONSE_BYTES = 2 * 1024 * 1024;
const DISCOVERY_TIMEOUT_MS = 10_000;

export type DiscoveryFailureKind =
	| "authentication"
	| "endpoint"
	| "timeout"
	| "redirect"
	| "malformed-response";

export type DiscoveryResult =
	| { outcome: "success"; catalog: string[] }
	| { outcome: "failure"; kind: DiscoveryFailureKind; message: string };

export interface DiscoveryInput {
	readonly profile: ConnectionProfileDraft;
	readonly secrets?: ConnectionProfileSecretSnapshot | null;
}

export interface DiscoveryOptions {
	readonly fetch?: ModelFetch;
}

/** @approved
 * Fetches the advisory catalog from the Profile's exact Models URL. This
 * intentionally uses one plain GET rather than an AI SDK provider so model
 * discovery remains common across all bundled adapters.
 */
export async function discoverModels(
	input: DiscoveryInput,
	options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
	const modelsUrl = input.profile.modelsUrl.trim();
	if (modelsUrl.length === 0) {
		return failure("endpoint", "Refresh requires an exact Models URL.");
	}
	try {
		const parsed = new URL(modelsUrl);
		if (
			(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
			parsed.username.length > 0 ||
			parsed.password.length > 0 ||
			parsed.hash.length > 0
		) {
			return failure("endpoint", "The Models URL must use HTTP or HTTPS without user information or a fragment.");
		}
	} catch {
		return failure("endpoint", "The Models URL must be a valid HTTP or HTTPS URL.");
	}

	const credential = input.secrets?.credential ?? null;
	const customHeaders = { ...input.secrets?.headers };
	const timeoutMs = input.profile.timeoutMs !== null && input.profile.timeoutMs > 0
		? input.profile.timeoutMs
		: DISCOVERY_TIMEOUT_MS;
	try {
		return await fetchWithTimeout(options.fetch ?? fetch, modelsUrl, {
			method: "GET",
			headers: authenticatedHeaders(undefined, credential, customHeaders),
			redirect: "error",
		}, timeoutMs, async (response, signal) => {
			if (response.status >= 300 && response.status < 400) {
				return failure("redirect", "The Models endpoint redirected the credentialed request, so it was not followed.");
			}
			if (!response.ok) {
				const snapshot = await snapshotProviderResponse(response);
				return failure(
					response.status === 401 || response.status === 403 ? "authentication" : "endpoint",
					formatProviderError(snapshot, "models"),
				);
			}

			const bounded = await readBoundedResponse(response, MAX_DISCOVERY_RESPONSE_BYTES, signal);
			if (bounded.truncated) {
				return failure("malformed-response", "The Models response is too large to read safely.");
			}
			const bytes = bounded.bytes;
			let parsed: JsonValue;
			try {
				// @approved
				//  SAFETY: the JSON parser establishes the only boundary at which the
				// untrusted response enters this module; parseCatalogBody validates the
				// concrete object shape before any field is consumed.
				parsed = JSON.parse(new TextDecoder().decode(bytes)) as JsonValue;
			} catch {
				return failure("malformed-response", "The Models endpoint returned invalid JSON.");
			}
			const catalog = parseCatalogBody(parsed);
			if (catalog === null) {
				return failure("malformed-response", "The Models endpoint did not return a data array.");
			}
			return { outcome: "success", catalog: normalizeDiscoveryCatalog(catalog.data) };
		});
	} catch (error) {
		if (error instanceof ModelFetchTimeoutError) {
			return failure("timeout", "The Models endpoint did not respond in time.");
		}
		if (error instanceof Error && /redirect/i.test(error.message)) {
			return failure("redirect", "The Models endpoint redirected the credentialed request, so it was not followed.");
		}
		if (error instanceof Error && (error.name === "AbortError" || /timeout/i.test(error.message))) {
			return failure("timeout", "The Models endpoint did not respond in time.");
		}
		return failure("endpoint", "The Models endpoint could not be reached.");
	}
}

export function normalizeDiscoveryCatalog(models: readonly ModelCatalogEntry[]): string[] {
	const unique = new Set<string>();
	for (const model of models) {
		const normalized = model.id.trim();
		if (normalized.length > 0) unique.add(normalized);
	}
	return [...unique].sort(compareModelIds);
}

type JsonValue = string | number | boolean | null | JsonValue[] | { readonly [key: string]: JsonValue };

interface ModelCatalogEntry {
	readonly id: string;
}

function parseCatalogBody(value: JsonValue): { data: ModelCatalogEntry[] } | null {
	const root = jsonObject(value);
	if (root === null || !Array.isArray(root.data)) return null;
	const data = root.data.flatMap((entry) => {
		const object = jsonObject(entry);
		const id = object?.id;
		if (id === undefined || Object.prototype.toString.call(id) !== "[object String]") return [];
		return [{ id: String(id) }];
	});
	return { data };
}

function jsonObject(value: JsonValue): { readonly [key: string]: JsonValue } | null {
	if (Object.prototype.toString.call(value) !== "[object Object]") return null;
	// @approved
	//  SAFETY: the object tag check above establishes a JSON object before this
	// assertion is used to inspect its named fields.
	return value as { readonly [key: string]: JsonValue };
}

function failure(kind: DiscoveryFailureKind, message: string): DiscoveryResult {
	return { outcome: "failure", kind, message };
}
