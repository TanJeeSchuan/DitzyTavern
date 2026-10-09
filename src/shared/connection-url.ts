import type { ConnectionProfileDraftPayload } from "./contract/connection-settings";

const requestPaths = { "chat-completions": "chat/completions", responses: "responses", "anthropic-messages": "messages", embeddings: "embeddings", "system-one": "systemone" } satisfies Record<ConnectionProfileDraftPayload["apiFormat"], string>;

export function resolveRequestUrl(requestUrl: string, apiFormat: ConnectionProfileDraftPayload["apiFormat"]): string {
	const parsed = new URL(requestUrl.trim());
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("The request URL must use HTTP or HTTPS.");
	}
	if (parsed.username.length > 0 || parsed.password.length > 0 || parsed.hash.length > 0) {
		throw new Error("The request URL must not contain user information or a fragment.");
	}
	if (parsed.pathname.endsWith("/")) {
		parsed.pathname = `${parsed.pathname}${requestPaths[apiFormat]}`;
	}
	return parsed.toString();
}
