import type { CodingModel } from "../../shared/contract/authoring";
import { resolveRequestUrl } from "../../shared/connection-url";
import type { ConnectionProfile, ConnectionProfileSecretSnapshot } from "../connection-settings";
import { authenticatedHeaders } from "../model-client/authenticated-headers";

const requestPath = "/chat/completions";
const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** @approved A response whose body aborts once no chunk arrives for `ms`, as the app's own Chat Completions requests do. */
const inactive = async (input: string, init: RequestInit, ms: number) => {
	const idle = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const reset = () => {
		clearTimeout(timer);
		timer = setTimeout(() => idle.abort(new Error(`The connection sent nothing for ${ms / 1000} seconds.`)), ms);
	};
	reset();
	try {
		const response = await fetch(input, { ...init, signal: init.signal === undefined || init.signal === null ? idle.signal : AbortSignal.any([init.signal, idle.signal]) });
		reset();
		const body = response.body?.pipeThrough(new TransformStream({ transform: (chunk, controller) => { reset(); controller.enqueue(chunk); }, flush: () => clearTimeout(timer) }));
		return new Response(body, response);
	} catch (error) {
		clearTimeout(timer);
		throw error;
	}
};

// @approved
//  A chat Connection Profile as libfx's custom provider, setting by setting:
//  - the request URL resolves as the app resolves it; it must end in
//    `/chat/completions`, which libfx appends to the base it is given, and
//    carry no query, and libfx sends HTTP only to localhost;
//  - the API key and custom headers go on each request exactly as the app's
//    own requests carry them, a custom `Authorization` winning over the key;
//  - the timeout is the app's: a response that sends nothing for that long
//    is aborted;
//  - no context window or output limit is declared, so libfx sends no
//    output limit and the provider's own default applies, whatever field
//    the profile names for it;
//  - the adapter, system placement and model backend shape the app's own
//    Prompt Plans, which the agent does not use, and libfx speaks plain Chat
//    Completions to OpenAI-compatible, DeepSeek and OpenRouter alike.
// Anything that cannot be mapped is refused with the reason the writer sees.
export const libfxProvider = (profile: ConnectionProfile, secrets: ConnectionProfileSecretSnapshot | null, choice: CodingModel) => {
	const refused = (reason: string) => ({ outcome: "refused", reason } as const);
	const name = profile.displayName;
	if (profile.apiFormat !== "chat-completions") return refused(`${name} is not a Chat Completions connection; the coding agent needs one.`);
	if (profile.credentialState === "unreadable") return refused(`${name}'s saved API key cannot be read. Save it again in Connections.`);
	let url: URL;
	try { url = new URL(resolveRequestUrl(profile.requestUrl, "chat-completions")); } catch (error) { return refused(`${name}'s request URL is not usable: ${error instanceof Error ? error.message : String(error)}`); }
	if (!url.pathname.endsWith(requestPath)) return refused(`${name}'s request URL must end in ${requestPath} for the coding agent.`);
	if (url.search !== "") return refused(`${name}'s request URL carries a query, which the coding agent cannot send.`);
	if (url.protocol === "http:" && !loopback.has(url.hostname)) return refused(`${name} uses HTTP; the coding agent sends HTTP only to localhost, so use HTTPS.`);
	const credential = secrets?.credential ?? null;
	const headers = secrets?.headers ?? {};
	const timeout = profile.timeoutMs;
	return {
		outcome: "mapped",
		options: {
			model: choice.model,
			provider: { name: "connection", baseUrl: url.href.slice(0, -requestPath.length), models: { [choice.model]: { supportsToolUse: true } } },
			fetch: (input: string, init: RequestInit) => {
				const authorized = { ...init, headers: authenticatedHeaders(init.headers, credential, headers) };
				return timeout === null || timeout <= 0 ? fetch(input, authorized) : inactive(input, authorized, timeout);
			},
		},
	} as const;
};
