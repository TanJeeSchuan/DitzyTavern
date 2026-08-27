import { describe, expect, test } from "bun:test";
import { discoverModels } from "./discovery";

const profile = {
	displayName: "Local",
	apiFormat: "chat-completions" as const,
	requestUrl: "http://127.0.0.1:43127/v1/",
	modelsUrl: "http://127.0.0.1:43127/v1/models?tenant=test",
	modelBackend: "automatic" as const,
	adapter: "openai-compatible" as const,
	outputTokenRepresentation: "automatic" as const,
	timeoutMs: 120_000,
	pinnedModels: ["custom-model"],
};

describe("Model discovery", () => {
	test("performs one credentialed, non-redirecting GET and normalizes IDs", async () => {
		let calls = 0;
		const result = await discoverModels(
			{
				profile,
				secrets: {
					credential: "discovery-secret",
					headers: { "X-Tenant": "tenant-secret", Authorization: "Custom auth" },
				},
			},
			{
				fetch: async (input, init) => {
					calls += 1;
					expect(String(input)).toBe(profile.modelsUrl);
					expect(init?.method).toBe("GET");
					expect(init?.redirect).toBe("error");
					const headers = new Headers(init?.headers);
					expect(headers.get("authorization")).toBe("Custom auth");
					expect(headers.get("x-tenant")).toBe("tenant-secret");
					return new Response(JSON.stringify({
						data: [
							{ id: " zeta " },
							{ id: "Alpha" },
							{ id: "alpha" },
							{ id: "" },
							{ id: " zeta " },
							{ id: 42 },
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } });
				},
			},
		);

		expect(calls).toBe(1);
		expect(result).toEqual({
			outcome: "success",
			catalog: ["Alpha", "alpha", "zeta"],
		});
	});

	test("reports failures without retrying or hiding the configured catalog contract", async () => {
		let calls = 0;
		const result = await discoverModels(
			{ profile, secrets: { credential: "secret", headers: {} } },
			{
				fetch: async (_input, init) => {
					calls += 1;
					expect(init?.redirect).toBe("error");
					return new Response(JSON.stringify({ message: "provider unavailable" }), {
						status: 503,
						headers: { "content-type": "application/json" },
					});
				},
			},
		);

		expect(calls).toBe(1);
		expect(result).toEqual({
			outcome: "failure",
			kind: "endpoint",
			message: "The Models endpoint request failed with HTTP 503 (34-byte response body).",
		});
	});

	test("reports only the size of an oversized provider body", async () => {
		const result = await discoverModels(
			{ profile, secrets: null },
			{
				fetch: async () => new Response("x".repeat(20 * 1024), {
					status: 503,
					headers: { "content-type": "text/plain" },
				}),
			},
		);

		expect(result.outcome).toBe("failure");
		if (result.outcome === "failure") {
			expect(result.message).toBe("The Models endpoint request failed with HTTP 503 (20480-byte response body).");
			expect(result.message).not.toContain("xxx");
		}
	});

	test("aborts a discovery request at the profile timeout", async () => {
		const result = await discoverModels(
			{ profile: { ...profile, timeoutMs: 5 }, secrets: null },
			{
				fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						const error = new Error("aborted");
						error.name = "AbortError";
						reject(error);
					});
				}),
			},
		);

		expect(result).toEqual({
			outcome: "failure",
			kind: "timeout",
			message: "The Models endpoint did not respond in time.",
		});
	});
});
