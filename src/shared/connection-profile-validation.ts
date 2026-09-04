export type ConnectionProfileSharedField =
	| "apiFormat"
	| "modelBackend"
	| "adapter"
	| "outputTokenRepresentation"
	| "requestUrl"
	| "modelsUrl"
	| "timeoutMs"
	| "header";

export interface ConnectionProfileValidationFailure {
	readonly field: ConnectionProfileSharedField;
	readonly message: string;
	readonly headerName?: string;
}

export interface SharedConnectionProfileDraft {
	readonly apiFormat: string;
	readonly modelBackend: string;
	readonly adapter: string;
	readonly outputTokenRepresentation: string;
	readonly requestUrl: string;
	readonly modelsUrl: string;
	readonly timeoutMs: number | null;
}

const SUPPORTED_MODEL_BACKENDS: readonly string[] = ["automatic", "ai-sdk"];

const SUPPORTED_ADAPTERS: readonly string[] = ["openai-compatible", "deepseek", "openrouter"];

const SUPPORTED_OUTPUT_TOKEN_REPRESENTATIONS: readonly string[] = [
	"automatic",
	"max_tokens",
	"max_completion_tokens",
	"omit",
];

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

export function validateConnectionProfileApiFormat(
	apiFormat: string,
): ConnectionProfileValidationFailure | null {
	if (apiFormat !== "chat-completions") {
		return {
			field: "apiFormat",
			message: "Only the Chat Completions API Format is available in version one.",
		};
	}
	return null;
}

export function validateConnectionProfileModelBackend(
	modelBackend: string,
): ConnectionProfileValidationFailure | null {
	if (!SUPPORTED_MODEL_BACKENDS.includes(modelBackend)) {
		return {
			field: "modelBackend",
			message: "The selected Model Backend is unavailable.",
		};
	}
	return null;
}

export function validateConnectionProfileAdapter(
	adapter: string,
): ConnectionProfileValidationFailure | null {
	if (!SUPPORTED_ADAPTERS.includes(adapter)) {
		return {
			field: "adapter",
			message: "The selected AI SDK Adapter is unavailable.",
		};
	}
	return null;
}

export function validateConnectionProfileOutputTokenRepresentation(
	outputTokenRepresentation: string,
): ConnectionProfileValidationFailure | null {
	if (!SUPPORTED_OUTPUT_TOKEN_REPRESENTATIONS.includes(outputTokenRepresentation)) {
		return {
			field: "outputTokenRepresentation",
			message: "The selected output-token representation is unavailable.",
		};
	}
	return null;
}

export function validateConnectionProfileUrl(
	value: string,
	label: "request URL" | "Models URL",
): ConnectionProfileValidationFailure | null {
	const field = label === "request URL" ? "requestUrl" : "modelsUrl";
	const normalized = value.trim();
	if (normalized.length === 0) return null;
	let parsed: URL;
	try {
		parsed = new URL(normalized);
	} catch {
		return {
			field,
			message: `The ${label} must be a valid HTTP or HTTPS URL.`,
		};
	}
	if (
		(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
		parsed.username.length > 0 ||
		parsed.password.length > 0 ||
		parsed.hash.length > 0
	) {
		return {
			field,
			message: `${label} must use HTTP or HTTPS without user information or a fragment.`,
		};
	}
	return null;
}

export function validateConnectionProfileTimeout(
	timeoutMs: number | null,
): ConnectionProfileValidationFailure | null {
	if (timeoutMs !== null && (!Number.isInteger(timeoutMs) || timeoutMs < 0)) {
		return {
			field: "timeoutMs",
			message: "Timeout must be zero, null, or a positive whole number of milliseconds.",
		};
	}
	return null;
}

export function validateConnectionProfileHeaderNames(
	names: readonly string[],
): ConnectionProfileValidationFailure | null {
	const seen = new Set<string>();
	for (const name of names) {
		const normalized = name.toLowerCase();
		if (!HTTP_TOKEN.test(name) || TRANSPORT_OWNED_HEADERS.has(normalized)) {
			return {
				field: "header",
				message: `Custom header name "${name}" is not a valid user-controlled HTTP header.`,
				headerName: name,
			};
		}
		if (seen.has(normalized)) {
			return {
				field: "header",
				message: `Custom header names must be unique case-insensitively: "${name}".`,
				headerName: name,
			};
		}
		seen.add(normalized);
	}
	return null;
}

export function validateConnectionProfileSharedDraft(
	draft: SharedConnectionProfileDraft,
): ConnectionProfileValidationFailure | null {
	return (
		validateConnectionProfileApiFormat(draft.apiFormat) ??
		validateConnectionProfileModelBackend(draft.modelBackend) ??
		validateConnectionProfileAdapter(draft.adapter) ??
		validateConnectionProfileOutputTokenRepresentation(draft.outputTokenRepresentation) ??
		validateConnectionProfileUrl(draft.requestUrl, "request URL") ??
		validateConnectionProfileUrl(draft.modelsUrl, "Models URL") ??
		validateConnectionProfileTimeout(draft.timeoutMs)
	);
}

export function validateConnectionProfileShared(
	draft: SharedConnectionProfileDraft,
	headerNames: readonly string[],
): ConnectionProfileValidationFailure | null {
	return (
		validateConnectionProfileSharedDraft(draft) ??
		validateConnectionProfileHeaderNames(headerNames)
	);
}
