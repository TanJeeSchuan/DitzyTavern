import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createEmbeddingSettingsModule } from "../embedding-settings";
import { evaluateSemanticLore } from "./semantic";

const entry = {
	id: 1,
	position: 1,
	title: "Harbor",
	content: "The harbor is old.",
	keywords: [],
	semanticTriggers: ["ships arrive"],
	matchOperator: "or" as const,
	always: false,
	requireAny: [], requireAll: [], excludeAny: [], excludeAll: [],
	caseSensitive: false, wholeWord: true, keywordMode: "literal" as const, regexFlags: "",
	semanticThreshold: null, priority: 0, enabled: true,
};

describe("semantic Lore evaluation", () => {
	let database: Database;
	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
		createEmbeddingSettingsModule(database, { masterKey: new Uint8Array(32).fill(5) }).apply({ type: "apply", expectedRevision: 0, endpoint: "http://localhost/v1/embeddings", model: "test", threshold: 0.7, deadlineMs: 1000 });
	});
	afterEach(() => database.close());

	test("compares triggers with individual sentences and reuses compatible vectors", async () => {
		let requests = 0;
		const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
			requests += 1;
			// ==[HUMAN APPROVED]== SAFETY: the client test sends this exact request body shape.
			const body = JSON.parse(String(init?.body)) as { input: string[] };
			return new Response(JSON.stringify({ data: body.input.map((_, index) => ({ embedding: index === 0 || index === 1 ? [1, 0] : [0, 1] })) }), { status: 200 });
		};
		const input = { database, entries: [entry], messages: [{ content: "A ship arrives. The market opens." }], fetch };
		const first = await evaluateSemanticLore(input);
		expect(first.available).toBe(true);
		expect(first.matches?.[0]).toMatchObject({ trigger: "ships arrive", sentence: "A ship arrives." });
		await evaluateSemanticLore(input);
		expect(requests).toBe(2);
	});

	test("uses one unavailable result for the whole pass", async () => {
		const result = await evaluateSemanticLore({ database, entries: [entry], messages: [{ content: "A ship arrives." }], fetch: async () => new Response("offline", { status: 503 }) });
		expect(result).toMatchObject({ available: false, threshold: 0.7 });
	});

	test("falls back when provider batches have incompatible or zero vectors", async () => {
		const dimensions = await evaluateSemanticLore({
			database,
			entries: [entry],
			messages: [{ content: "A ship arrives." }],
			fetch: async (_input, init) => {
				// ==[HUMAN APPROVED]== SAFETY: the test client sends the exact request body shape asserted here.
				const body = JSON.parse(String(init?.body)) as { input: string[] };
				return new Response(JSON.stringify({ data: body.input.map((value) => ({ embedding: value === "ships arrive" ? [1, 0] : [1, 0, 0] })) }), { status: 200 });
			},
		});
		expect(dimensions.available).toBe(false);

		const zero = await evaluateSemanticLore({
			database,
			entries: [{ ...entry, semanticTriggers: ["zero vector"] }],
			messages: [{ content: "A zero vector." }],
			fetch: async (_input, init) => {
				// ==[HUMAN APPROVED]== SAFETY: the test client sends the exact request body shape asserted here.
				const body = JSON.parse(String(init?.body)) as { input: string[] };
				return new Response(JSON.stringify({ data: body.input.map(() => ({ embedding: [0, 0] })) }), { status: 200 });
			},
		});
		expect(zero.available).toBe(false);
	});

	test("retains the strongest semantic evidence when its cosine score is negative", async () => {
		const result = await evaluateSemanticLore({
			database,
			entries: [entry],
			messages: [{ content: "An unrelated sentence." }],
			fetch: async (_input, init) => {
				// ==[HUMAN APPROVED]== SAFETY: the test client sends the exact request body shape asserted here.
				const body = JSON.parse(String(init?.body)) as { input: string[] };
				return new Response(JSON.stringify({ data: body.input.map((value) => ({ embedding: value === "ships arrive" ? [1, 0] : [-1, 0] })) }), { status: 200 });
			},
		});
		expect(result).toMatchObject({ available: true, matches: [{ trigger: "ships arrive", score: -1, sentence: "An unrelated sentence." }] });
	});
});
