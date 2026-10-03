import { describe, expect, test } from "bun:test";
import { cosineSimilarity, requestEmbeddings } from "./embeddings";

describe("embedding client", () => {
	test("requests OpenAI-compatible vectors", async () => {
		let body: string | undefined;
		const vectors = await requestEmbeddings(["one", "two"], {
			endpoint: "http://localhost/v1/embeddings",
			model: "test-model",
			secrets: { credential: "secret", headers: {} },
			timeoutMs: 1000,
			fetch: async (_input, init) => {
				body = String(init?.body);
				return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] }), { status: 200 });
			},
		});
		expect(JSON.parse(body ?? "{}")).toEqual({ model: "test-model", input: ["one", "two"] });
		expect(vectors).toEqual([[1, 0], [0, 1]]);
	});

	test("rejects vectors with inconsistent dimensions", async () => {
		await expect(requestEmbeddings(["one", "two"], {
			endpoint: "http://localhost/v1/embeddings",
			model: "test-model",
			secrets: null,
			timeoutMs: 1000,
			fetch: async () => Response.json({ data: [{ embedding: [1, 0] }, { embedding: [1] }] }),
		})).rejects.toMatchObject({ name: "EmbeddingServiceError", kind: "malformed-response" });
	});

	test("normalizes cosine similarity and distinguishes orthogonal, opposite, and zero vectors", () => {
		expect(cosineSimilarity([3, 4], [4, 3])).toBeCloseTo(0.96);
		expect(cosineSimilarity([3, 0], [0, 4])).toBe(0);
		expect(cosineSimilarity([3, 4], [-3, -4])).toBeCloseTo(-1);
		expect(cosineSimilarity([0, 0], [3, 4])).toBe(0);
	});
});

