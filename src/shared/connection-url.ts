export function resolveChatCompletionsRequestUrl(requestUrl: string): string {
	const parsed = new URL(requestUrl.trim());
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("The request URL must use HTTP or HTTPS.");
	}
	if (parsed.username.length > 0 || parsed.password.length > 0 || parsed.hash.length > 0) {
		throw new Error("The request URL must not contain user information or a fragment.");
	}
	if (parsed.pathname.endsWith("/")) {
		parsed.pathname = `${parsed.pathname}chat/completions`;
	}
	return parsed.toString();
}
