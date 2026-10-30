import type { BunFile } from "bun";
import { Elysia } from "elysia";

// @approved
//  Every GET answer carries a validator of its own bytes, so a browser
// revalidates instead of downloading again. A validator of the content, not of
// a revision, is never stale: many reads project several aggregates, and some
// writes advance no revision. A proxy that compresses may weaken a validator,
// so a match ignores the weak prefix.
const unchanged = (request: Request, etag: string) =>
	request.headers.get("if-none-match")?.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag.slice(2)) ?? false;

const revalidated = (request: Request, etag: string, body: BodyInit, headers: Record<string, string>) => unchanged(request, etag)
	? new Response(null, { status: 304, headers: { etag, "cache-control": headers["cache-control"] ?? "no-cache" } })
	: new Response(body, { headers: { "cache-control": "no-cache", ...headers, etag } });

/** @approved A file's validator is its size and modification time. */
export const revalidatedFile = (request: Request, file: BunFile, headers: Record<string, string> = {}) =>
	revalidated(request, `W/"${file.size.toString(36)}-${file.lastModified.toString(36)}"`, file, { "content-type": file.type, ...headers });

/** @approved A text answer's validator is a hash of its bytes. */
export const revalidatedText = (request: Request, body: string, headers: Record<string, string>) =>
	revalidated(request, `W/"${Bun.hash(body).toString(36)}"`, body, headers);

export const contentValidators = new Elysia({ name: "content-validators" }).mapResponse({ as: "global" }, ({ request, responseValue, set }) => {
	// @approved A plain object or array is a JSON answer; a Response, file, stream or status envelope keeps Elysia's own mapping.
	const json = responseValue != null && (Array.isArray(responseValue) || Object.getPrototypeOf(responseValue) === Object.prototype);
	if (request.method !== "GET" || (set.status ?? 200) !== 200 || !json) return;
	const body = JSON.stringify(responseValue);
	const headers = Object.fromEntries(Object.entries(set.headers).map(([name, value]) => [name, String(value)]));
	return revalidatedText(request, body, { ...headers, "content-type": "application/json;charset=utf-8" });
});
