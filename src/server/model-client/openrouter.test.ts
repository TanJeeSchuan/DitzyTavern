import { describe, expect, test } from "bun:test";
import type { ConnectionProfile } from "../connection-settings/types";
import {
	collectModelClientGeneration,
	createOpenRouterModelClient,
	ModelClientTransportError,
} from ".";

const profile: ConnectionProfile = {
	id: 9,
	displayName: "OpenRouter",
	apiFormat: "chat-completions",
	requestUrl: "http://127.0.0.1:43127/api/v1/",
	modelsUrl: "http://127.0.0.1:43127/api/v1/models",
	modelBackend: "automatic",
	adapter: "openrouter",
	outputTokenRepresentation: "automatic",
	timeoutMs: 120_000,
	pinnedModels: [],
	backendOptions: {},
	credentialConfigured: true,
	headers: [],
};

const generationSettings = {
	temperature: 0.7,
	topP: null,
	frequencyPenalty: null,
	presencePenalty: null,
	contextLimit: 32768,
	responseBudget: 64,
	requestOverrides: { "chat-completions": {} },
};

interface CapturedBody {
	model?: string;
	stream?: boolean;
}

const streamResponse = () => new Response([
	`data: ${JSON.stringify({
		id: "gen-openrouter",
		choices: [{
			index: 0,
			delta: {
				reasoning_details: [{ type: "reasoning.text", text: "Plan first. " }],
				content: "OpenRouter ",
			},
			finish_reason: null,
		}],
	})}\n\n`,
	`data: ${JSON.stringify({
		id: "gen-openrouter",
		choices: [{
			index: 0,
			delta: { content: "reply." },
			finish_reason: null,
		}],
	})}\n\n`,
	`data: ${JSON.stringify({
		id: "gen-openrouter",
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
	})}\n\n`,
	"data: [DONE]\n\n",
].join(""), { headers: { "content-type": "text/event-stream" } });

describe("OpenRouter Model Client", () => {
	test("uses the dedicated adapter with the resolved endpoint and normalizes content, reasoning, finish, and usage", async () => {
		let request: { url: string; headers: Headers; body: CapturedBody } | undefined;
		const client = createOpenRouterModelClient({
			profile,
			secrets: {
				credential: "openrouter-secret-never-returned",
				headers: { "X-Route": "route-secret-never-returned" },
			},
			fetch: async (input, init) => {
				request = {
					url: String(input),
					headers: new Headers(init?.headers),
					// SAFETY: the controlled fake receives the adapter's JSON body and
					// this test only inspects its provider-neutral request fields.
					// SAFETY: the controlled fake receives the provider request and this
					// test reads only its model and stream fields.
					body: JSON.parse(String(init?.body)) as CapturedBody,
				};
				return streamResponse();
			},
		});

		const result = await collectModelClientGeneration(client, {
			promptPlan: {
				blocks: [{ kind: "system-instruction", content: "Answer." }],
				warnings: [],
			},
			modelId: "deepseek/deepseek-v4-flash",
			generationSettings,
		});

		expect(result.content).toBe("OpenRouter reply.");
		expect(result.reasoning).toBe("Plan first. ");
		expect(result.finishReason).toBe("stop");
		expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
		expect(request?.url).toBe("http://127.0.0.1:43127/api/v1/chat/completions");
		expect(request?.headers.get("authorization")).toBe("Bearer openrouter-secret-never-returned");
		expect(request?.headers.get("x-route")).toBe("route-secret-never-returned");
		expect(request?.headers.get("http-referer")).toBeNull();
		expect(request?.headers.get("x-openrouter-title")).toBeNull();
		expect(request?.body.model).toBe("deepseek/deepseek-v4-flash");
		expect(request?.body.stream).toBe(true);
		expect(JSON.stringify(request)).toContain("openrouter-secret-never-returned");
	});

	test("normalizes OpenRouter errors without leaking dedicated secrets", async () => {
		const credential = "openrouter-error-secret-never-returned";
		const headerValue = "openrouter-route-secret-never-returned";
		const client = createOpenRouterModelClient({
			profile,
			secrets: { credential, headers: { "X-Route": headerValue } },
			fetch: async () => new Response(JSON.stringify({
				error: { message: `The route rejected ${credential} via ${headerValue}.` },
			}), { status: 429, headers: { "content-type": "application/json" } }),
		});

		try {
			for await (const _event of client.generate({
				promptPlan: {
					blocks: [{ kind: "system-instruction", content: "Answer." }],
					warnings: [],
				},
				modelId: "deepseek/deepseek-v4-flash",
				generationSettings,
			})) {
				// The controlled provider rejects before emitting a normalized event.
			}
			throw new Error("Expected the OpenRouter request to fail.");
		} catch (error) {
			expect(error).toBeInstanceOf(ModelClientTransportError);
			if (!(error instanceof ModelClientTransportError)) return;
			expect(error.kind).toBe("provider");
			expect(error.message).toContain("HTTP 429");
			expect(error.message).not.toContain(credential);
			expect(error.message).not.toContain(headerValue);
		}
	});
});
