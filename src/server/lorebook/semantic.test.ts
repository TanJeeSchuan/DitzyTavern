import { describe, expect, test } from "bun:test";
import { evaluateSemanticLore, type SemanticSettingsSnapshot } from "./semantic";
import { tokenxEstimator } from "../prompt-compiler";

const entry = { enabled: true, semanticTriggers: ["ships arrive"] };
const settings: SemanticSettingsSnapshot = { mode: "jev", threshold: 0.5, jevModel: "jev-1.13.0", credential: "typesafe-secret" };
const unreachable = async (): Promise<Response> => { throw new Error("Jev must not be called."); };

describe("semantic Lore evaluation", () => {
	test("asks Jev one question per distinct trigger against the scan window", async () => {
		let body = "";
		const result = await evaluateSemanticLore({
			entries: [entry, { enabled: true, semanticTriggers: ["ships arrive", "a storm breaks"] }, { enabled: false, semanticTriggers: ["disabled trigger"] }],
			messages: [{ content: "A ship arrives." }, { id: null, content: "Writer waves." }],
			settings,
			fetch: async (_input, init) => {
				body = String(init?.body);
				return Response.json({ answers: { trigger_0: { type: "noul", noul: 0.9 }, trigger_1: { type: "noul", noul: 0.1 } } });
			},
		});
		// SAFETY: the fake captures the request emitted by evaluateSemanticLore, whose shape is asserted below.
		const sent = JSON.parse(body) as { model: string; state: { scene: string[] }; questions: Record<string, { instructions: { situation: string } }> };
		expect(sent.model).toBe("jev-1.13.0");
		expect(sent.state.scene).toEqual(["A ship arrives.", "Writer waves."]);
		expect(Object.values(sent.questions).map((question) => question.instructions.situation)).toEqual(["ships arrive", "a storm breaks"]);
		expect(result).toEqual({ available: true, threshold: 0.5, matches: [{ trigger: "ships arrive", score: 0.9 }, { trigger: "a storm breaks", score: 0.1 }] });
	});

	test("reports why the whole pass is unavailable without calling Jev when off or unconfigured", async () => {
		expect(await evaluateSemanticLore({ entries: [entry], messages: [], settings: { ...settings, mode: "off" }, fetch: unreachable }))
			.toMatchObject({ available: false, fallbackReason: "Semantic Triggers are turned off in Model Settings." });
		expect(await evaluateSemanticLore({ entries: [entry], messages: [], settings: { ...settings, credential: null }, fetch: unreachable }))
			.toMatchObject({ available: false, fallbackReason: expect.stringContaining("Typesafe credential") });
	});

	test("keeps each request within Jev limits by trimming the oldest scene text and splitting triggers", async () => {
		const bodies: { state: { scene: string[] }; questions: Record<string, { type: string }> }[] = [];
		const triggers = Array.from({ length: 120 }, (_, index) => `situation ${index} ${"detail ".repeat(300)}`);
		const result = await evaluateSemanticLore({
			entries: [{ enabled: true, semanticTriggers: triggers }],
			messages: [{ content: "oldest ".repeat(40_000) }, { content: `${"filler ".repeat(40_000)}newest line` }],
			settings,
			fetch: async (_input, init) => {
				// SAFETY: the fake captures the request emitted by evaluateSemanticLore, whose shape is asserted below.
				const body = JSON.parse(String(init?.body)) as { state: { scene: string[] }; questions: Record<string, { type: string }> };
				bodies.push(body);
				return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 0.9 }])) });
			},
		});
		expect(bodies.length).toBeGreaterThan(1);
		expect(bodies.every((body) => tokenxEstimator(JSON.stringify(body.state)) <= 16_000)).toBe(true);
		expect(bodies[0]?.state.scene).toHaveLength(1);
		expect(bodies[0]?.state.scene[0]).toEndWith("newest line");
		expect(result.available).toBe(true);
		expect(result.matches).toHaveLength(triggers.length);
	});

	test("uses one unavailable result when Jev fails", async () => {
		const result = await evaluateSemanticLore({ entries: [entry], messages: [{ content: "A ship arrives." }], settings, fetch: async () => new Response("offline", { status: 503 }) });
		expect(result).toMatchObject({ available: false, threshold: 0.5, fallbackReason: "Typesafe Jev request failed with HTTP 503." });
	});
});
