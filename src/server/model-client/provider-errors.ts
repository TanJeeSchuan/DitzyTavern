const MAX_PROVIDER_ERROR_BYTES = 16 * 1024;

export interface ProviderErrorContext {
	readonly credential: string | null;
	readonly headers: Readonly<Record<string, string>>;
}

export interface ProviderErrorLike extends Error {
	readonly cause?: Error;
	readonly statusCode?: number;
	readonly status?: number;
	readonly responseBody?: string;
	readonly responseHeaders?: Readonly<Record<string, string>>;
}

export interface ProviderErrorSnapshot {
	readonly status?: number;
	readonly contentType?: string;
	readonly body?: string;
	readonly bodyBytes: number;
}

interface ProviderErrorSummary {
	readonly contentType?: string;
	readonly bodyBytes: number;
	readonly message?: string;
	readonly truncated: boolean;
}

export async function snapshotProviderResponse(
	response: Response,
): Promise<ProviderErrorSnapshot> {
	const contentType = response.headers.get("content-type") ?? undefined;
	let body: string | undefined;
	let bodyBytes = 0;
	try {
		const bytes = new Uint8Array(await response.arrayBuffer());
		bodyBytes = bytes.byteLength;
		if (contentType === undefined || isTextualContentType(contentType)) {
			body = new TextDecoder().decode(bytes);
		}
	} catch {
		// The status remains actionable even when the provider body cannot be read.
	}
	return { status: response.status, contentType, body, bodyBytes };
}

export function snapshotProviderError(error: ProviderErrorLike): ProviderErrorSnapshot {
	const body = error.responseBody;
	return {
		status: error.statusCode ?? error.status,
		contentType: readHeader(error.responseHeaders, "content-type"),
		body,
		bodyBytes: body === undefined ? 0 : new TextEncoder().encode(body).byteLength,
	};
}

/**
 * Formats provider diagnostics only after selecting conventional message
 * fields, redacting credentials and headers, and applying a UTF-8 byte cap.
 */
export function formatProviderError(
	snapshot: ProviderErrorSnapshot,
	context: ProviderErrorContext,
		subject: "provider" | "models" = "provider",
): string {
	const prefix = subject === "models" ? "The Models endpoint" : "The provider";
	if (snapshot.contentType !== undefined && !isTextualContentType(snapshot.contentType)) {
		return `${prefix} returned HTTP ${snapshot.status ?? "an error"} with ${snapshot.contentType} content (${snapshot.bodyBytes} bytes).`;
	}

	const summary = summarizeProviderError(snapshot, context);
	if (summary.message !== undefined) {
		return `${prefix} returned HTTP ${snapshot.status ?? "an error"}: ${summary.message}${summary.truncated ? " (truncated)" : ""}`;
	}
	return `${prefix} request failed${snapshot.status === undefined ? "." : ` with HTTP ${snapshot.status}.`}`;
}

function summarizeProviderError(
	snapshot: ProviderErrorSnapshot,
	context: ProviderErrorContext,
): ProviderErrorSummary {
	const candidate = snapshot.body === undefined
		? undefined
		: extractProviderMessage(snapshot.body) ?? snapshot.body;
	if (candidate === undefined) {
		return {
			contentType: snapshot.contentType,
			bodyBytes: snapshot.bodyBytes,
			truncated: false,
		};
	}

	const safe = redactProviderMessage(candidate, context);
	if (safe === undefined) {
		return {
			contentType: snapshot.contentType,
			bodyBytes: snapshot.bodyBytes,
			truncated: false,
		};
	}
	const bounded = boundProviderMessage(safe);
	return {
		contentType: snapshot.contentType,
		bodyBytes: snapshot.bodyBytes,
		message: bounded.value,
		truncated: bounded.truncated,
	};
}

export function providerErrorStatus(error: ProviderErrorLike): number | undefined {
	return error.statusCode ?? error.status;
}

export function isTextualContentType(contentType: string): boolean {
	const normalized = contentType.toLowerCase();
	return normalized.startsWith("text/") || normalized.includes("json") || normalized.includes("xml");
}

interface ConventionalProviderError {
	readonly message?: string;
	readonly detail?: string;
	readonly title?: string;
	readonly error?: ConventionalProviderError;
}

function extractProviderMessage(body: string): string | undefined {
	try {
		// SAFETY: only conventional string fields are consumed from the untrusted body.
		const parsed = JSON.parse(body) as ConventionalProviderError | null;
		const message = [
			parsed?.error?.message,
			parsed?.message,
			parsed?.detail,
			parsed?.title,
		].find((candidate) => Object.prototype.toString.call(candidate) === "[object String]");
		if (message === undefined) return undefined;
		const text = String(message).trim();
		return text.length === 0 ? undefined : text;
	} catch {
		return undefined;
	}
}

function redactProviderMessage(
	value: string,
	context: ProviderErrorContext,
): string | undefined {
	let result = value;
	for (const secret of [context.credential ?? "", ...Object.values(context.headers)]) {
		if (secret.length > 0) result = result.split(secret).join("[redacted]");
	}
	result = Array.from(result, (character) => {
		const code = character.codePointAt(0) ?? 32;
		return code < 32 || code === 127 ? " " : character;
	}).join("").replace(/\s+/g, " ").trim();
	return result.length === 0 ? undefined : result;
}

interface BoundProviderMessage {
	readonly value: string;
	readonly truncated: boolean;
}

function boundProviderMessage(value: string): BoundProviderMessage {
	let bytes = 0;
	let result = "";
	for (const character of value) {
		const characterBytes = new TextEncoder().encode(character).byteLength;
		if (bytes + characterBytes > MAX_PROVIDER_ERROR_BYTES) {
			return { value: result, truncated: true };
		}
		bytes += characterBytes;
		result += character;
	}
	return { value: result, truncated: false };
}

function readHeader(
	headers: Readonly<Record<string, string>> | undefined,
	name: string,
): string | undefined {
	if (headers === undefined) return undefined;
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name) return value;
	}
	return undefined;
}
