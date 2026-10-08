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

/** @approved
 * Summarizes a failed provider response from its headers alone. The untrusted
 * body is never read or buffered; the reported size comes from Content-Length
 * when the provider declares one and is omitted otherwise.
 */
export async function snapshotProviderResponse(
	response: Response,
): Promise<ProviderErrorSnapshot> {
	const contentType = response.headers.get("content-type") ?? undefined;
	return {
		status: response.status,
		contentType,
		bodyBytes: declaredContentLength(response.headers),
	};
}

function declaredContentLength(headers: Headers): number {
	const value = headers.get("content-length");
	if (value === null) return 0;
	const trimmed = value.trim();
	return /^\d+$/.test(trimmed) ? Number(trimmed) : 0;
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

/** @approved
 * Formats provider diagnostics from server-owned fields only. Provider bodies
 * are untrusted and can echo request URLs, credentials, headers, or arbitrary
 * secrets that the server cannot reliably discover and redact.
 */
export function formatProviderError(
	snapshot: ProviderErrorSnapshot,
	subject: "provider" | "models" = "provider",
): string {
	const prefix = subject === "models" ? "The Models endpoint" : "The provider";
	if (snapshot.contentType !== undefined && !isTextualContentType(snapshot.contentType)) {
		const size = snapshot.bodyBytes > 0 ? ` (${snapshot.bodyBytes} bytes)` : "";
		return `${prefix} returned HTTP ${snapshot.status ?? "an error"} with a binary response body${size}.`;
	}
	const responseSize = snapshot.bodyBytes > 0 ? ` (${snapshot.bodyBytes}-byte response body)` : "";
	return `${prefix} request failed${snapshot.status === undefined ? "" : ` with HTTP ${snapshot.status}`}${responseSize}.`;
}

export function providerErrorStatus(error: ProviderErrorLike): number | undefined {
	return error.statusCode ?? error.status;
}

export function isTextualContentType(contentType: string): boolean {
	const normalized = contentType.toLowerCase();
	return normalized.startsWith("text/") || normalized.includes("json") || normalized.includes("xml");
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
