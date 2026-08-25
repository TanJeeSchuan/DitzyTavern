export function authenticatedHeaders(
	input: HeadersInit | undefined,
	credential: string | null,
	customHeaders: Readonly<Record<string, string>>,
): Headers {
	const result = new Headers(input);
	for (const [name, value] of Object.entries(customHeaders)) result.set(name, value);
	const authorization = Object.entries(customHeaders).find(
		([name]) => name.toLowerCase() === "authorization",
	)?.[1];
	if (authorization !== undefined) {
		result.delete("authorization");
		result.set("authorization", authorization);
	} else if (credential !== null && credential.length > 0) {
		result.set("authorization", `Bearer ${credential}`);
	} else {
		result.delete("authorization");
	}
	return result;
}
