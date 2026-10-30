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

const revalidated = (request: Request, etag: string, body: BodyInit, init: HeadersInit) => {
	const headers = new Headers(init);
	if (!headers.has("cache-control")) headers.set("cache-control", "no-cache");
	headers.set("etag", etag);
	return unchanged(request, etag)
		? new Response(null, { status: 304, headers: { etag, "cache-control": headers.get("cache-control")! } }) // @approved Set just above.
		: new Response(body, { headers });
};

/** @approved A file's validator is its size and modification time. */
export const revalidatedFile = (request: Request, file: BunFile) =>
	revalidated(request, `W/"${file.size.toString(36)}-${file.lastModified.toString(36)}"`, file, { "content-type": file.type });

/** @approved A text answer's validator is a hash of its bytes. */
export const revalidatedText = (request: Request, body: string, headers: HeadersInit) =>
	revalidated(request, `W/"${Bun.hash(body).toString(36)}"`, body, headers);

export const contentValidators = new Elysia({ name: "content-validators" }).mapResponse({ as: "global" }, ({ request, responseValue, set }) => {
	// @approved A plain object or array is a JSON answer; a Response, file, stream or status envelope keeps Elysia's own mapping.
	const json = responseValue != null && (Array.isArray(responseValue) || Object.getPrototypeOf(responseValue) === Object.prototype);
	if (request.method !== "GET" || (set.status ?? 200) !== 200 || !json) return;
	const body = JSON.stringify(responseValue);
	// @approved A repeated header, such as two cookies, stays two headers.
	const headers = Object.entries(set.headers).flatMap(([name, value]) => [value].flat().map((each): [string, string] => [name, String(each)]));
	return revalidatedText(request, body, [...headers.filter(([name]) => name.toLowerCase() !== "content-type"), ["content-type", "application/json;charset=utf-8"]]);
});
