import { describe, expect, test } from "bun:test";
import type { ConnectionProfileDraft } from "../connection-settings/types";
import {
	resolveTestConnectionBackend,
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
	backendOptions: {},
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

describe("DeepSeek Test Connection", () => {
	test("resolves Automatic to AI SDK before making one exact authenticated request", async () => {
		let request: { url: string; init: RequestInit } | undefined;
		const result = await testDeepSeekConnection({
			profile,
			modelId: "custom-model-id",
			credential: "stored-secret",
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
			credential: "secret-never-display",
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
			credential: "secret",
		}, {
			fetch: async () => {
				calls += 1;
				throw new TypeError("redirect mode is set to error");
			},
		});
		expect(redirected).toMatchObject({ outcome: "failure", kind: "redirect" });
		expect(calls).toBe(1);

		const unavailable = await testDeepSeekConnection({
			profile: { ...profile, adapter: "openrouter" },
			modelId: "deepseek-chat",
		});
		expect(unavailable).toMatchObject({ outcome: "failure", kind: "adapter-unavailable" });
		expect(calls).toBe(1);
	});

	test("reports a successful HTTP response with an invalid provider body as malformed", async () => {
		const result = await testDeepSeekConnection({
			profile,
			modelId: "deepseek-chat",
			credential: "secret",
		}, {
			fetch: async () => new Response("not-json", {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		});

		expect(result).toMatchObject({ outcome: "failure", kind: "malformed-response" });
	});

	test("bounds textual fallback and summarizes binary upstream failures", async () => {
		const longBody = "x".repeat(20_000);
		const textual = await testDeepSeekConnection({
			profile,
			modelId: "deepseek-chat",
			credential: "secret",
		}, {
			fetch: async () => new Response(longBody, {
				status: 500,
				headers: { "content-type": "text/plain" },
			}),
		});
		expect(textual).toMatchObject({ outcome: "failure", kind: "endpoint" });
		expect(failureMessage(textual).length).toBeLessThan(17_000);

		const binary = await testDeepSeekConnection({
			profile,
			modelId: "deepseek-chat",
			credential: "secret",
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
});
