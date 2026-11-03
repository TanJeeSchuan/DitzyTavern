import { expect, test } from "bun:test";
import { createFxAgent, memory } from "libfx";
import { blankConnectionProfileDraft, type ConnectionProfilePayload } from "../../shared/contract/connection-settings";
import { libfxProvider } from "./provider";

const profile = (fields: Partial<ConnectionProfilePayload>): ConnectionProfilePayload => ({
	...blankConnectionProfileDraft, id: 1, displayName: "Coder", requestUrl: "https://coder.invalid/v1/", discoveryCatalog: [], textOnlyModels: [], credentialState: "saved", headers: [], ...fields,
});
const choice = { profileId: 1, model: "coder-1", contextWindow: 32_000, maxOutputTokens: 2_048 };

test("a profile maps to libfx's provider: its base URL, key, custom headers and limits reach a localhost fake", async () => {
	const seen: { path: string; authorization: string | null; tenant: string | null; body: { model: string; max_tokens: number } }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 0,
		async fetch(request) {
			seen.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization"), tenant: request.headers.get("x-tenant"), body: await request.json() });
			const chunk = { id: "fake", object: "chat.completion.chunk", created: 1, model: "coder-1", choices: [{ index: 0, delta: { role: "assistant", content: "Ready." }, finish_reason: "stop" }] };
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
		},
	});
	const mapped = libfxProvider(profile({ requestUrl: `http://127.0.0.1:${server.port}/v1/` }), { credential: "sk-coder", headers: { "X-Tenant": "ditzy" } }, choice);
	if (mapped.outcome !== "mapped") throw new Error(mapped.reason);
	const agent = createFxAgent({ backend: "wasm", durability: memory(), ...mapped.options });
	try {
		const result = await agent.session().prompt("Hello.").result;
		expect(result.stopReason).toBe("end_turn");
		expect(seen).toEqual([{ path: "/v1/chat/completions", authorization: "Bearer sk-coder", tenant: "ditzy", body: expect.objectContaining({ model: "coder-1", max_tokens: 2_048 }) }]);
	} finally {
		await agent.close();
		await server.stop(true);
	}
});

test("a profile setting libfx cannot carry is refused with the reason the writer sees", () => {
	const reason = (fields: Partial<ConnectionProfilePayload>, limits = choice) => {
		const mapped = libfxProvider(profile(fields), null, limits);
		return mapped.outcome === "refused" ? mapped.reason : "mapped";
	};
	expect(reason({})).toBe("mapped");
	expect(reason({ apiFormat: "responses" })).toBe("Coder is not a Chat Completions connection; the coding agent needs one.");
	expect(reason({ requestUrl: "http://192.168.1.4:8080/v1/" })).toBe("Coder uses HTTP; the coding agent sends HTTP only to localhost, so use HTTPS.");
	expect(reason({ requestUrl: "https://coder.invalid/v1/generate" })).toBe("Coder's request URL must end in /chat/completions for the coding agent.");
	expect(reason({ requestUrl: "https://coder.invalid/v1/chat/completions?key=1" })).toBe("Coder's request URL carries a query, which the coding agent cannot send.");
	expect(reason({ outputTokenRepresentation: "max_completion_tokens" })).toBe("Coder sends the output limit as max_completion_tokens; the coding agent sends max_tokens.");
	expect(reason({ credentialState: "unreadable" })).toBe("Coder's saved API key cannot be read. Save it again in Connections.");
	expect(reason({}, { ...choice, maxOutputTokens: choice.contextWindow })).toBe("The output limit must be smaller than the context window.");
});
