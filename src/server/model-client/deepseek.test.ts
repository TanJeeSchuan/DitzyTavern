import { describe, expect, test } from "bun:test";
import type { ConnectionProfile } from "../connection-settings/types";
import { createDeepSeekModelClient, ModelClientTransportError } from ".";

const profile: ConnectionProfile = {
	id: 7,
	displayName: "DeepSeek",
	apiFormat: "chat-completions",
	requestUrl: "http://127.0.0.1:43127/v1/",
	modelsUrl: "",
	modelBackend: "automatic",
	adapter: "deepseek",
	outputTokenRepresentation: "automatic",
	timeoutMs: 120_000,
	pinnedModels: [],
	discoveryCatalog: [],
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
	requestOverrides: { "chat-completions": { custom_field: "kept" } },
};

interface CapturedBody {
	model?: string;
	max_tokens?: number;
	custom_field?: string;
}

const streamResponse = () => {
	const encoder = new TextEncoder();
	const chunks = [
		`data: ${JSON.stringify({
			id: "chatcmpl-test",
			choices: [{ index: 0, delta: { content: "Visible " }, finish_reason: null }],
		})}\n\n`,
		`data: ${JSON.stringify({
			id: "chatcmpl-test",
			choices: [{ index: 0, delta: { content: "reply." }, finish_reason: null }],
		})}\n\n`,
		`data: ${JSON.stringify({
			id: "chatcmpl-test",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		})}\n\n`,
		"data: [DONE]\n\n",
	];
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			},
		}),
		{ headers: { "content-type": "text/event-stream" } },
	);
};

describe("DeepSeek production Model Client", () => {
	test("normalizes visible text chunks and pins the resolved authenticated request", async () => {
		let request: { url: string; body: CapturedBody; auth: string | null } | undefined;
		const client = createDeepSeekModelClient({
			profile,
			secrets: { credential: "secret-never-returned", headers: {} },
			fetch: async (input, init) => {
				request = {
					url: String(input),
					// SAFETY: the controlled fake receives the AI SDK Chat Completions
					// body and this test reads only its model and token fields.
					body: JSON.parse(String(init?.body)) as CapturedBody,
					auth: new Headers(init?.headers).get("authorization"),
				};
				return streamResponse();
			},
		});
		const events = [];
		for await (const event of client.generate({
			promptPlan: {
				blocks: [{ kind: "system-instruction", content: "Stay concise." }],
				warnings: [],
			},
			modelId: "custom-model",
			generationSettings,
		})) {
			events.push(event);
		}

		expect(events).toEqual([
			{ type: "content", text: "Visible " },
			{ type: "content", text: "reply." },
			{ type: "finished", finishReason: "stop" },
		]);
		expect(request?.url).toBe("http://127.0.0.1:43127/v1/chat/completions");
		expect(request?.auth).toBe("Bearer secret-never-returned");
		expect(request?.body.model).toBe("custom-model");
		expect(request?.body.max_tokens).toBe(64);
		expect(request?.body.custom_field).toBe("kept");
		expect(JSON.stringify(request)).toContain("secret-never-returned");
	});

	test("aborts an inactive stream without imposing a total-duration limit", async () => {
		const client = createDeepSeekModelClient({
			profile: { ...profile, timeoutMs: 20 },
			secrets: { credential: "secret", headers: {} },
			fetch: async () => new Response(
				new ReadableStream<Uint8Array>({ start() {} }),
				{ headers: { "content-type": "text/event-stream" } },
			),
		});

		try {
			for await (const _event of client.generate({
				promptPlan: { blocks: [{ kind: "system-instruction", content: "Wait." }], warnings: [] },
				modelId: "custom-model",
				generationSettings,
			})) {
				// The inactive stream must not produce a terminal success event.
			}
			throw new Error("Expected inactivity to abort the stream.");
		} catch (error) {
			expect(error).toBeInstanceOf(ModelClientTransportError);
			if (!(error instanceof ModelClientTransportError)) return;
			expect(error.kind).toBe("inactivity");
			expect(error.message).toContain("inactive");
		}
	});

	test("reports bounded provider diagnostics without leaking Profile secrets", async () => {
		const credential = "credential-never-returned";
		const customHeaderValue = "custom-header-never-returned";
		const client = createDeepSeekModelClient({
			profile,
			secrets: { credential, headers: { "x-routing": customHeaderValue } },
			fetch: async () => new Response(
				JSON.stringify({
					error: {
					message: `${"diagnostic ".repeat(2_000)} ${credential} ${customHeaderValue}`,
				},
				}),
				{ status: 401, headers: { "content-type": "application/json" } },
			),
		});

		try {
			for await (const _event of client.generate({
				promptPlan: { blocks: [{ kind: "system-instruction", content: "Reply." }], warnings: [] },
				modelId: "custom-model",
				generationSettings,
			})) {
				// The provider rejects before emitting any normalized stream event.
			}
			throw new Error("Expected the provider response to fail.");
		} catch (error) {
			expect(error).toBeInstanceOf(ModelClientTransportError);
			if (!(error instanceof ModelClientTransportError)) return;
			expect(error.kind).toBe("provider");
			expect(error.message).toContain("HTTP 401");
			expect(error.message).toContain("(truncated)");
			expect(error.message).not.toContain(credential);
			expect(error.message).not.toContain(customHeaderValue);
			expect(error.message.length).toBeLessThan(16_500);
		}
	});
});
