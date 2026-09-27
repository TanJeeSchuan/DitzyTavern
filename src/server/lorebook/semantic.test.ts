import { describe, expect, test } from "bun:test";
import { evaluateSemanticLore, type SemanticSettingsSnapshot } from "./semantic";

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

	test("uses one unavailable result when Jev fails", async () => {
		const result = await evaluateSemanticLore({ entries: [entry], messages: [{ content: "A ship arrives." }], settings, fetch: async () => new Response("offline", { status: 503 }) });
		expect(result).toMatchObject({ available: false, threshold: 0.5, fallbackReason: "Typesafe Jev request failed with HTTP 503." });
	});
});
