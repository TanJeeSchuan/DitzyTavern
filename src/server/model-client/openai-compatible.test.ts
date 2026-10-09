import { describe, expect, test } from "bun:test";
import type { ConnectionProfile } from "../connection-settings/types";
import {
	collectModelClientGeneration,
	createOpenAICompatibleModelClient,
} from ".";

const profile: ConnectionProfile = {
	id: 8,
	displayName: "Local",
	apiFormat: "chat-completions",
	requestUrl: "http://127.0.0.1:43127/generate",
	modelsUrl: "",
	modelBackend: "automatic",
	adapter: "openai-compatible",
	outputTokenRepresentation: "max_completion_tokens",
	timeoutMs: 120_000,
	pinnedModels: [],
	discoveryCatalog: [],
	textOnlyModels: [],
	credentialConfigured: false,
	headers: [],
};

const settings = {
	temperature: null,
	topP: null,
	frequencyPenalty: null,
	presencePenalty: null,
	contextLimit: 100,
	responseBudget: 42,
	// The Model Client input receives the Request Overrides already narrowed
	// to the active API Format namespace by the Generation Plan Compiler.
	requestOverrides: {
		messages: [{ role: "system", content: "blocked" }],
		model: "blocked",
		stream: false,
		n: 2,
		max_tokens: 900,
		provider_extension: { enabled: true },
	},
};

function streamResponse(): Response {
	return new Response([
		`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }] })}\n\n`,
		`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
		"data: [DONE]\n\n",
	].join(""), { headers: { "content-type": "text/event-stream" } });
}

interface CapturedBody {
	model?: string;
	stream?: boolean;
	messages?: Array<{ role: string; content: string }>;
	n?: number;
	max_tokens?: number;
	max_completion_tokens?: number;
	provider_extension?: { enabled: boolean };
}

describe("OpenAI Compatible Model Client", () => {
	test("uses an exact endpoint, custom Authorization, custom headers, and safe late overrides", async () => {
		let request: { url: string; headers: Headers; body: CapturedBody } | undefined;
		const client = createOpenAICompatibleModelClient({
			profile,
			secrets: {
				credential: null,
				headers: {
					Authorization: "Custom secret never returned",
					"X-Route": "route secret never returned",
				},
			},
			fetch: async (input, init) => {
				request = {
					url: String(input),
					headers: new Headers(init?.headers),
					// SAFETY: the controlled fake receives the adapter's JSON body and
					// this test reads only the declared Chat Completions fields.
					body: JSON.parse(String(init?.body)) as CapturedBody,
				};
				return streamResponse();
			},
		});

		const result = await collectModelClientGeneration(client, {
			promptPlan: { blocks: [{ kind: "system-instruction", role: "system", content: "Answer." }], warnings: [], images: [] },
			modelId: "local-model",
			generationSettings: settings,
		});

		expect(result.content).toBe("OK");
		expect(request?.url).toBe("http://127.0.0.1:43127/generate");
		expect(request?.headers.get("authorization")).toBe("Custom secret never returned");
		expect(request?.headers.get("x-route")).toBe("route secret never returned");
		expect(request?.body.model).toBe("local-model");
		expect(request?.body.stream).toBe(true);
		expect(request?.body.n).not.toBe(2);
		expect(request?.body.max_tokens).toBeUndefined();
		expect(request?.body.max_completion_tokens).toBe(42);
		expect(request?.body.provider_extension).toEqual({ enabled: true });
	});

	test("appends chat completions only to a conventional base URL", async () => {
		let url = "";
		let body: CapturedBody | undefined;
		const client = createOpenAICompatibleModelClient({
			profile: { ...profile, requestUrl: "http://127.0.0.1:43127/v1/", outputTokenRepresentation: "omit" },
			secrets: null,
			fetch: async (input, init) => {
				url = String(input);
				// SAFETY: the controlled fake receives the adapter's JSON body and
				// this test reads only the declared Chat Completions fields.
				body = JSON.parse(String(init?.body)) as CapturedBody;
				return streamResponse();
			},
		});
		await collectModelClientGeneration(client, {
			promptPlan: { blocks: [{ kind: "system-instruction", role: "system", content: "Answer." }], warnings: [], images: [] },
			modelId: "local-model",
			generationSettings: settings,
		});
		expect(url).toBe("http://127.0.0.1:43127/v1/chat/completions");
		expect(body?.max_tokens).toBeUndefined();
		expect(body?.max_completion_tokens).toBeUndefined();
	});

	test("returns a provider stream error without replacing it", async () => {
		const client = createOpenAICompatibleModelClient({
			profile,
			secrets: null,
			fetch: async () => new Response(
				`data: ${JSON.stringify({ error: { message: "raw upstream failure" } })}\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			),
		});

		await expect(collectModelClientGeneration(client, {
			promptPlan: { blocks: [{ kind: "system-instruction", role: "system", content: "Answer." }], warnings: [], images: [] },
			modelId: "local-model",
			generationSettings: settings,
		})).rejects.toMatchObject({
			kind: "provider",
			message: JSON.stringify({ message: "raw upstream failure" }),
		});
	});

	test("preserves prompt roles and history text without adding speaker labels", async () => {
		let body: CapturedBody | undefined;
		const client = createOpenAICompatibleModelClient({
			profile: { ...profile, outputTokenRepresentation: "omit" },
			secrets: null,
			fetch: async (_input, init) => {
				// SAFETY: this fake receives the adapter's JSON body; the assertion reads
				// only the declared Chat Completions message projection.
				body = JSON.parse(String(init?.body)) as CapturedBody;
				return streamResponse();
			},
		});

		await collectModelClientGeneration(client, {
			promptPlan: {
				blocks: [
					{ kind: "system-instruction", role: "system", content: "System" },
					{ kind: "identity", role: "human", content: "Identity" },
					{ kind: "identity", role: "model", content: "Model identity" },
					{ kind: "scenario", role: "system", content: "Scenario" },
					{ kind: "example-dialogue", role: "system", content: "Example" },
					{ kind: "history", speakerName: "Human", content: "Hello", role: "human" },
					{ kind: "history", speakerName: "Model", content: "Hi", role: "model" },
					{ kind: "history", speakerName: "Rulership", content: "Rulership: Authored label", role: "model" },
					{ kind: "history", speakerName: null, content: "Unattributed", role: null },
					{ kind: "post-history-instruction", role: "system", content: "Continue" },
				],
				warnings: [], images: [],
			},
			modelId: "local-model",
			generationSettings: settings,
		});

			expect(body?.messages).toEqual([
			{ role: "system", content: "System" },
			{ role: "user", content: "Identity" },
			{ role: "assistant", content: "Model identity" },
			{ role: "system", content: "Scenario" },
			{ role: "system", content: "Example" },
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi" },
			{ role: "assistant", content: "Rulership: Authored label" },
			{ role: "user", content: "Unattributed" },
			{ role: "system", content: "Continue" },
		]);
	});

	test("rejects unsupported request overrides before contacting the provider", async () => {
		let calls = 0;
		const client = createOpenAICompatibleModelClient({
			profile,
			secrets: null,
			fetch: async () => {
				calls += 1;
				return streamResponse();
			},
		});

		await expect(collectModelClientGeneration(client, {
			promptPlan: { blocks: [{ kind: "system-instruction", role: "system", content: "Answer." }], warnings: [], images: [] },
			modelId: "local-model",
			generationSettings: {
				...settings,
				requestOverrides: {
					...settings.requestOverrides,
					tools: [],
				},
			},
		})).rejects.toMatchObject({
			name: "ModelClientGenerationError",
			kind: "protocol",
		});
		expect(calls).toBe(0);
	});

	test("places the preceding model text in the assistant prefill slot", async () => {
		for (const suffix of ["", " ", "\n", "\n\n"] as const) {
			let body: CapturedBody | undefined;
			const client = createOpenAICompatibleModelClient({
				profile: { ...profile, outputTokenRepresentation: "omit" },
				secrets: null,
				fetch: async (_input, init) => {
					// SAFETY: this controlled fake receives the adapter's JSON request body.
					body = JSON.parse(String(init?.body)) as CapturedBody;
					return streamResponse();
				},
			});
			await collectModelClientGeneration(client, {
				promptPlan: {
					blocks: [
						{ kind: "system-instruction", role: "system", content: "System" },
						{ kind: "history", speakerName: "Maren", content: "Previous model text.", role: "model" },
					],
					warnings: [], images: [],
					intent: { type: "continuation", strategy: "assistant-prefill", suffix },
				},
				assistantPrefill: { prefix: "Previous model text.", suffix },
				modelId: "local-model",
				generationSettings: settings,
			});
			expect(body?.messages).toEqual([
				{ role: "system", content: "System" },
				{ role: "assistant", content: `Previous model text.${suffix}` },
			]);
		}
	});
});
