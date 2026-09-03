import type { ConnectionProfileDraft } from "./connection-settings";
import type { HeaderEditorData } from "./connection-settings-state";

const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const TRANSPORT_OWNED_HEADERS = new Set([
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

export function connectionDraftValidationError(
	draft: ConnectionProfileDraft,
	headerEditorData: HeaderEditorData,
): string | null {
	return connectionBasicDraftValidationError(draft) ?? connectionAdvancedDraftValidationError(draft, headerEditorData);
}

export function connectionBasicDraftValidationError(
	draft: ConnectionProfileDraft,
): string | null {
	if (draft.displayName.trim().length === 0) {
		return "A Connection Profile display name is required.";
	}
	if (draft.pinnedModels.some((model) => model.trim().length === 0)) {
		return "Pinned model IDs cannot be blank.";
	}
	return null;
}

export function connectionAdvancedDraftValidationError(
	draft: ConnectionProfileDraft,
	headerEditorData: HeaderEditorData,
): string | null {
	if (draft.apiFormat !== "chat-completions") {
		return "Only the Chat Completions API Format is available in version one.";
	}
	if (draft.modelBackend !== "automatic" && draft.modelBackend !== "ai-sdk") {
		return "The selected Model Backend is unavailable.";
	}
	if (!(["openai-compatible", "deepseek", "openrouter"] as const).includes(draft.adapter)) {
		return "The selected AI SDK Adapter is unavailable.";
	}
	if (!(["automatic", "max_tokens", "max_completion_tokens", "omit"] as const).includes(draft.outputTokenRepresentation)) {
		return "The selected output-token representation is unavailable.";
	}
	const requestUrlError = validateOptionalUrl(draft.requestUrl, "request URL");
	if (requestUrlError !== null) return requestUrlError;
	const modelsUrlError = validateOptionalUrl(draft.modelsUrl, "Models URL");
	if (modelsUrlError !== null) return modelsUrlError;
	if (draft.timeoutMs !== null && (!Number.isInteger(draft.timeoutMs) || draft.timeoutMs < 0)) {
		return "Timeout must be zero, null, or a positive whole number of milliseconds.";
	}
	const headerError = validateHeaders(headerEditorData);
	if (headerError !== null) return headerError;
	return null;
}

function validateOptionalUrl(value: string, label: string): string | null {
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

function validateHeaders(headerEditorData: HeaderEditorData): string | null {
	const seen = new Set<string>();
	for (const name of Object.keys(headerEditorData)) {
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
