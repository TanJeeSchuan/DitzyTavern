import { describe, expect, test } from "bun:test";
import { cosineSimilarity, requestEmbeddings } from "./embeddings";

describe("embedding client", () => {
	test("requests OpenAI-compatible vectors and validates dimensions", async () => {
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
		expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
	});
});

