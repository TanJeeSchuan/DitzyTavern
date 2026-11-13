import type { ConnectionProfileDraftPayload } from "./contract/connection-settings";

type ApiFormat = ConnectionProfileDraftPayload["apiFormat"];
type ImageRequest = { adapter: ConnectionProfileDraftPayload["adapter"]; references: boolean };

const requestPaths = { "chat-completions": "chat/completions", responses: "responses", "anthropic-messages": "messages", embeddings: "embeddings", "system-one": "systemone" } satisfies Record<Exclude<ApiFormat, "images">, string>;

export function resolveRequestUrl(requestUrl: string, ...[apiFormat, imageRequest]: [apiFormat: Exclude<ApiFormat, "images">, imageRequest?: ImageRequest] | [apiFormat: "images", imageRequest: ImageRequest]): string {
	const parsed = new URL(requestUrl.trim());
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("The request URL must use HTTP or HTTPS.");
	}
	if (parsed.username.length > 0 || parsed.password.length > 0 || parsed.hash.length > 0) {
		throw new Error("The request URL must not contain user information or a fragment.");
	}
	if (parsed.pathname.endsWith("/")) {
		const path = apiFormat === "images"
			? imageRequest.adapter === "openrouter" ? "images" : imageRequest.references ? "images/edits" : "images/generations"
			: requestPaths[apiFormat];
		parsed.pathname = `${parsed.pathname}${path}`;
	}
	return parsed.toString();
}
