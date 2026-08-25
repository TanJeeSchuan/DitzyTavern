import type {
	ConnectionProfileDraft,
	ConnectionProfileSecretSnapshot,
} from "../connection-settings/types";
import { authenticatedHeaders } from "./authenticated-headers";
import type { ModelFetch } from "./test-connection";

const MAX_DISCOVERY_RESPONSE_BYTES = 2 * 1024 * 1024;

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

/**
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
	try {
		const response = await (options.fetch ?? fetch)(modelsUrl, {
			method: "GET",
			headers: authenticatedHeaders(undefined, credential, customHeaders),
			redirect: "error",
		});
		if (response.status >= 300 && response.status < 400) {
			return failure("redirect", "The Models endpoint redirected the credentialed request, so it was not followed.");
		}
		if (!response.ok) {
			return failure(
				response.status === 401 || response.status === 403 ? "authentication" : "endpoint",
				await providerFailureMessage(response, credential, customHeaders),
			);
		}

		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > MAX_DISCOVERY_RESPONSE_BYTES) {
			return failure("malformed-response", "The Models response is too large to read safely.");
		}
		let parsed: JsonValue;
		try {
			// SAFETY: the JSON parser establishes the only boundary at which the
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
	} catch (error) {
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
	// SAFETY: the object tag check above establishes a JSON object before this
	// assertion is used to inspect its named fields.
	return value as { readonly [key: string]: JsonValue };
}

function compareModelIds(left: string, right: string): number {
	const leftFolded = left.toLocaleLowerCase();
	const rightFolded = right.toLocaleLowerCase();
	if (leftFolded < rightFolded) return -1;
	if (leftFolded > rightFolded) return 1;
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

async function providerFailureMessage(
	response: Response,
	credential: string | null,
	customHeaders: Readonly<Record<string, string>>,
): Promise<string> {
	const contentType = response.headers.get("content-type") ?? "";
	if (contentType.length > 0 && !isTextualContentType(contentType)) {
		const bytes = new Uint8Array(await response.arrayBuffer());
		return `The Models endpoint returned HTTP ${response.status} with ${contentType} content (${bytes.byteLength} bytes).`;
	}
	const text = await response.text().catch(() => "");
	const message = extractMessage(text) ?? text.trim();
	if (message.length === 0) return `The Models endpoint returned HTTP ${response.status}.`;
	let safe = message;
	for (const secret of [credential ?? "", ...Object.values(customHeaders)]) {
		if (secret.length > 0) safe = safe.split(secret).join("[redacted]");
	}
	return `The Models endpoint returned HTTP ${response.status}: ${safe.slice(0, 16_384)}`;
}

function extractMessage(value: string): string | undefined {
	try {
		// SAFETY: JSON.parse is followed by jsonObject/jsonString checks before
		// any provider-controlled field is read.
		const parsed = JSON.parse(value) as JsonValue;
		const root = jsonObject(parsed);
		const nested = jsonObject(root?.error ?? null);
		const message = jsonString(nested?.message) ?? jsonString(root?.message) ?? jsonString(root?.detail);
		return message ?? (value.trim().length > 0 ? value.trim() : undefined);
	} catch {
		return value.trim().length > 0 ? value.trim() : undefined;
	}
}

function jsonString(value: JsonValue | undefined): string | undefined {
	if (value === undefined || Object.prototype.toString.call(value) !== "[object String]") return undefined;
	return String(value).trim() || undefined;
}

function isTextualContentType(contentType: string): boolean {
	const normalized = contentType.toLowerCase();
	return normalized.startsWith("text/") || normalized.includes("json") || normalized.includes("xml");
}

function failure(kind: DiscoveryFailureKind, message: string): DiscoveryResult {
	return { outcome: "failure", kind, message };
}
