import { describe, expect, test } from "bun:test";
import type { ConnectionProfileDraft } from "../connection-settings/types";
import {
	resolveTestConnectionBackend,
	testConnection,
	testDeepSeekConnection,
	TEST_CONNECTION_MAX_OUTPUT_TOKENS,
	TEST_CONNECTION_PROMPT,
	type TestConnectionResult,
} from ".";

const profile: ConnectionProfileDraft = {
	displayName: "DeepSeek",
	apiFormat: "chat-completions",
	requestUrl: "http://127.0.0.1:43127/v1/?tenant=test",
	modelsUrl: "",
	modelBackend: "automatic",
	adapter: "deepseek",
	outputTokenRepresentation: "automatic",
	timeoutMs: 120_000,
	pinnedModels: [],
};

const successfulResponse = () => new Response(JSON.stringify({
	id: "chatcmpl-test",
	object: "chat.completion",
	created: 1,
	model: "deepseek-chat",
	choices: [{
		index: 0,
		message: { role: "assistant", content: "OK" },
		finish_reason: "stop",
	}],
	usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
}), {
	status: 200,
	headers: { "content-type": "application/json" },
});

const failureMessage = (result: TestConnectionResult): string =>
	result.outcome === "failure" ? result.message : "";

describe("Model Test Connection", () => {
	test("tests a generic exact endpoint with custom authentication without persisting or exposing secrets", async () => {
		let request: { url: string; headers: Headers; body: { model: string; max_tokens: number } } | undefined;
		const result = await testConnection({
			profile: { ...profile, adapter: "openai-compatible", requestUrl: "http://127.0.0.1:43127/generate" },
			modelId: "local-model",
			secrets: {
				credential: null,
				headers: {
					Authorization: "Custom secret never returned",
					"X-Route": "route secret never returned",
				},
			},
		}, {
			fetch: async (input, init) => {
				request = {
					url: String(input),
					headers: new Headers(init?.headers),
					// SAFETY: the controlled fake receives the adapter's JSON body and
					// this test reads only the declared test-request fields.
					body: JSON.parse(String(init?.body)) as { model: string; max_tokens: number },
				};
				return successfulResponse();
			},
		});
		expect(result.outcome).toBe("success");
		expect(request?.url).toBe("http://127.0.0.1:43127/generate");
		expect(request?.headers.get("authorization")).toBe("Custom secret never returned");
		expect(request?.headers.get("x-route")).toBe("route secret never returned");
		expect(request?.body.model).toBe("local-model");
		expect(request?.body.max_tokens).toBe(TEST_CONNECTION_MAX_OUTPUT_TOKENS);
		// The transient result is deliberately free of all credentials and headers.
		expect(JSON.stringify(result)).not.toContain("secret never returned");
	});

	test("tests OpenRouter through its dedicated adapter without optional attribution headers", async () => {
		let request: { url: string; headers: Headers; body: { model: string; max_tokens: number } } | undefined;
		const result = await testConnection({
			profile: {
				...profile,
				adapter: "openrouter",
				requestUrl: "http://127.0.0.1:43127/api/v1/",
			},
			modelId: "deepseek/deepseek-v4-flash",
			secrets: { credential: "openrouter-secret-never-returned", headers: {} },
		}, {
			fetch: async (input, init) => {
				request = {
					url: String(input),
					headers: new Headers(init?.headers),
					// SAFETY: the controlled fake receives the adapter's JSON body and
					// this test reads only its test request fields.
					body: JSON.parse(String(init?.body)) as { model: string; max_tokens: number },
				};
				return successfulResponse();
			},
		});

		expect(result.outcome).toBe("success");
		expect(request?.url).toBe("http://127.0.0.1:43127/api/v1/chat/completions");
		expect(request?.headers.get("authorization")).toBe("Bearer openrouter-secret-never-returned");
		expect(request?.headers.get("http-referer")).toBeNull();
		expect(request?.headers.get("x-openrouter-title")).toBeNull();
		expect(request?.body.model).toBe("deepseek/deepseek-v4-flash");
		expect(request?.body.max_tokens).toBe(TEST_CONNECTION_MAX_OUTPUT_TOKENS);
		expect(JSON.stringify(result)).not.toContain("openrouter-secret-never-returned");
	});

	test("resolves Automatic to AI SDK before making one exact authenticated request", async () => {
		let request: { url: string; init: RequestInit } | undefined;
		const result = await testDeepSeekConnection({
			profile,
			modelId: "custom-model-id",
			secrets: { credential: "stored-secret", headers: {} },
		}, {
			fetch: async (input, init) => {
				request = { url: String(input), init: init ?? {} };
				return successfulResponse();
			},
		});

		expect(resolveTestConnectionBackend("automatic")).toBe("ai-sdk");
		expect(result.outcome).toBe("success");
		expect(request?.url).toBe("http://127.0.0.1:43127/v1/chat/completions?tenant=test");
		expect(request?.init.method).toBe("POST");
		expect(request?.init.redirect).toBe("error");
		expect(new Headers(request?.init.headers).get("authorization")).toBe("Bearer stored-secret");
		// SAFETY: the fake fetch receives the AI SDK Chat Completions body and
		// this test reads only fields guaranteed by the adapter contract.
		const body = JSON.parse(String(request?.init.body)) as {
			model: string;
			max_tokens: number;
			messages: Array<{ role: string; content: string }>;
		};
		expect(body.model).toBe("custom-model-id");
		expect(body.max_tokens).toBe(TEST_CONNECTION_MAX_OUTPUT_TOKENS);
		expect(body.messages).toEqual([{ role: "user", content: TEST_CONNECTION_PROMPT }]);
	});

	test("does not retry authentication failures and never exposes the credential", async () => {
		let calls = 0;
		const result = await testDeepSeekConnection({
			profile,
			modelId: "deepseek-chat",
			secrets: { credential: "secret-never-display", headers: {} },
		}, {
			fetch: async () => {
				calls += 1;
				return new Response(JSON.stringify({ error: { message: "bad secret-never-display" } }), {
					status: 401,
					headers: { "content-type": "application/json" },
				});
			},
		});

		expect(calls).toBe(1);
		expect(result).toMatchObject({ outcome: "failure", kind: "authentication" });
		expect(JSON.stringify(result)).not.toContain("secret-never-display");
	});

	test("normalizes redirects and unavailable adapters without making a fallback request", async () => {
		let calls = 0;
		const redirected = await testDeepSeekConnection({
			profile,
			modelId: "deepseek-chat",
			secrets: { credential: "secret", headers: {} },
		}, {
			fetch: async () => {
				calls += 1;
				throw new TypeError("redirect mode is set to error");
			},
		});
		expect(redirected).toMatchObject({ outcome: "failure", kind: "redirect" });
		expect(calls).toBe(1);

		const unavailable = await testDeepSeekConnection({
			// SAFETY: this intentionally simulates a newer persisted adapter identifier
			// that is outside the current closed adapter vocabulary.
			profile: { ...profile, adapter: "future-adapter" as ConnectionProfileDraft["adapter"] },
			modelId: "deepseek-chat",
		});
		expect(unavailable).toMatchObject({ outcome: "failure", kind: "adapter-unavailable" });
		expect(calls).toBe(1);
	});

	test("reports a successful HTTP response with an invalid provider body as malformed", async () => {
		const result = await testDeepSeekConnection({
			profile,
			modelId: "deepseek-chat",
			secrets: { credential: "secret", headers: {} },
		}, {
			fetch: async () => new Response("not-json", {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		});

		expect(result).toMatchObject({ outcome: "failure", kind: "malformed-response" });
	});

	test("omits textual response bodies and summarizes binary upstream failures", async () => {
		const longBody = "x".repeat(20_000);
		const textual = await testDeepSeekConnection({
			profile,
			modelId: "deepseek-chat",
			secrets: { credential: "secret", headers: {} },
		}, {
			fetch: async () => new Response(longBody, {
				status: 500,
				headers: { "content-type": "text/plain" },
			}),
		});
		expect(textual).toMatchObject({ outcome: "failure", kind: "endpoint" });
		expect(failureMessage(textual)).toContain("20000-byte response body");
		expect(failureMessage(textual)).not.toContain("xxx");

		const binary = await testDeepSeekConnection({
			profile,
			modelId: "deepseek-chat",
			secrets: { credential: "secret", headers: {} },
		}, {
			fetch: async () => new Response(new Uint8Array([1, 2, 3, 4]), {
				status: 500,
				headers: { "content-type": "application/octet-stream" },
			}),
		});
		expect(binary).toMatchObject({ outcome: "failure", kind: "endpoint" });
		expect(failureMessage(binary)).toContain("application/octet-stream");
		expect(failureMessage(binary)).toContain("bytes");
	});

	test("requires a model ID and uses a bounded timeout", async () => {
		const missingModel = await testDeepSeekConnection({ profile, modelId: "" });
		expect(missingModel).toMatchObject({ outcome: "failure", kind: "endpoint" });

		const timedOut = await testDeepSeekConnection({
			profile,
			modelId: "deepseek-chat",
		}, {
			timeoutMs: 5,
			fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					const error = new Error("aborted");
					error.name = "AbortError";
					reject(error);
				});
			}),
		});
		expect(timedOut).toMatchObject({ outcome: "failure", kind: "timeout" });
	});

	test("treats a zero Profile timeout as disabled instead of a one-millisecond Test Connection", async () => {
		const result = await testConnection({
			profile: { ...profile, timeoutMs: 0 },
			modelId: "deepseek-chat",
		}, {
			timeoutMs: 100,
			fetch: async () => {
				await new Promise((resolve) => setTimeout(resolve, 20));
				return successfulResponse();
			},
		});

		expect(result.outcome).toBe("success");
	});
});
