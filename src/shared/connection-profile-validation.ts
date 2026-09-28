import type { ConnectionProfileDraftPayload } from "./contract/connection-settings";

const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const TRANSPORT_OWNED_HEADERS: ReadonlySet<string> = new Set([
	"accept-encoding",
	"connection",
	"content-encoding",
	"content-length",
	"content-type",
	"host",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

function connectionProfileUrlValidationError(
	value: string,
	label: "request URL" | "Models URL",
): string | null {
	const normalized = value.trim();
	if (normalized.length === 0) return null;
	let parsed: URL;
	try {
		parsed = new URL(normalized);
	} catch {
		return `The ${label} must be a valid HTTP or HTTPS URL.`;
	}
	if (
		(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
		parsed.username.length > 0 ||
		parsed.password.length > 0 ||
		parsed.hash.length > 0
	) {
		return `${label} must use HTTP or HTTPS without user information or a fragment.`;
	}
	return null;
}

export function sharedConnectionHeaderNamesValidationError(
	names: readonly string[],
): string | null {
	const seen = new Set<string>();
	for (const name of names) {
		const normalized = name.toLowerCase();
		if (!HTTP_TOKEN.test(name) || TRANSPORT_OWNED_HEADERS.has(normalized)) {
			return `Custom header name "${name}" is not a valid user-controlled HTTP header.`;
		}
		if (seen.has(normalized)) {
			return `Custom header names must be unique case-insensitively: "${name}".`;
		}
		seen.add(normalized);
	}
	return null;
}

export function sharedConnectionProfileDraftValidationError(
	draft: ConnectionProfileDraftPayload,
): string | null {
	if (draft.apiFormat !== "chat-completions" && draft.apiFormat !== "embeddings") {
		return "Only the Chat Completions and Embeddings API Formats are available.";
	}
	if (draft.apiFormat === "embeddings" && !(draft.timeoutMs !== null && draft.timeoutMs > 0)) {
		return "An Embeddings connection needs a positive timeout.";
	}
	return (
		connectionProfileUrlValidationError(draft.requestUrl, "request URL") ??
		connectionProfileUrlValidationError(draft.modelsUrl, "Models URL") ??
		(draft.timeoutMs !== null && (!Number.isInteger(draft.timeoutMs) || draft.timeoutMs < 0)
			? "Timeout must be zero, null, or a positive whole number of milliseconds."
			: null)
	);
}

export function sharedConnectionProfileValidationError(
	draft: ConnectionProfileDraftPayload,
	headerNames: readonly string[],
): string | null {
	return (
		sharedConnectionProfileDraftValidationError(draft) ??
		sharedConnectionHeaderNamesValidationError(headerNames)
	);
}
