import { describe, expect, test } from "bun:test";
import { evaluateSemanticLore, type SemanticSettingsSnapshot } from "./semantic";
import { tokenxEstimator } from "../prompt-compiler";

const entry = { enabled: true, semanticTriggers: ["ships arrive"] };
const settings = { decisionProfileId: 1, decisionModel: "jev-1.13.0", decisionStateTokenLimit: 16000, triggerThreshold: 0.5, kind: "ready", decision: { profileName: "Decision test", model: "jev-1.13.0", stateTokenLimit: 16000, endpoint: "http://decision.test/v1/systemone", credential: "decision-secret", headers: {}, timeoutMs: 15000 } } satisfies SemanticSettingsSnapshot;
const unreachable = async (): Promise<Response> => { throw new Error("The Decision Model must not be called."); };

describe("semantic Lore evaluation", () => {
	test("asks the Decision Model one question per distinct trigger against the scan window", async () => {
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

	test("reports why the whole pass is unavailable without calling the Decision Model when off or unconfigured", async () => {
		const { decision: _decision, ...selection } = settings;
		expect(await evaluateSemanticLore({ entries: [entry], messages: [], settings: { ...selection, decisionProfileId: null, kind: "off" }, fetch: unreachable }))
			.toMatchObject({ available: false, fallbackReason: "Semantic Triggers are turned off. Choose a Decision Model under Connections." });
		expect(await evaluateSemanticLore({ entries: [entry], messages: [], settings: { ...selection, kind: "unavailable", reason: "Decision Model unavailable" }, fetch: unreachable }))
			.toMatchObject({ available: false, fallbackReason: expect.stringContaining("Decision Model unavailable") });
	});

	test("covers the whole scan window within Decision Model limits, two requests at a time", async () => {
		const bodies: { model: string; state: { scene: string[] }; questions: Record<string, { type: string }> }[] = [];
		const triggers = Array.from({ length: 120 }, (_, index) => `situation ${index} ${"detail ".repeat(300)}`);
		let inFlight = 0;
		let peakInFlight = 0;
		const result = await evaluateSemanticLore({
			entries: [{ enabled: true, semanticTriggers: triggers }],
			messages: [{ content: `only in the oldest message ${"oldest ".repeat(40_000)}` }, { content: `${"filler ".repeat(40_000)}newest line` }],
			settings,
			fetch: async (_input, init) => {
				// SAFETY: the fake captures the request emitted by evaluateSemanticLore, whose shape is asserted below.
				const body = JSON.parse(String(init?.body)) as { model: string; state: { scene: string[] }; questions: Record<string, { type: string }> };
				bodies.push(body);
				peakInFlight = Math.max(peakInFlight, ++inFlight);
				await Bun.sleep(1);
				inFlight -= 1;
				const seesOldest = body.state.scene.some((text) => text.startsWith("only in the oldest message"));
				return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul: seesOldest && id === "trigger_0" ? 0.9 : 0.1 }])) });
			},
		});
		for (const body of bodies) expect(tokenxEstimator(JSON.stringify(body.state))).toBeLessThanOrEqual(settings.decisionStateTokenLimit);
		expect(bodies.length).toBeLessThan(triggers.length);
		expect(peakInFlight).toBe(2);
		const scanned = bodies.flatMap((body) => body.state.scene).join("");
		expect(scanned).toContain("only in the oldest message");
		expect(scanned).toContain("newest line");
		expect(result.matches).toHaveLength(triggers.length);
		expect(result.matches?.[0]).toEqual({ trigger: triggers[0], score: 0.9 });
	});

	test("uses one unavailable result when the Decision Model fails", async () => {
		const result = await evaluateSemanticLore({ entries: [entry], messages: [{ content: "A ship arrives." }], settings, fetch: async () => new Response("offline", { status: 503 }) });
		expect(result).toMatchObject({ available: false, threshold: 0.5, fallbackReason: "Decision Model request failed with HTTP 503." });
	});

	test("cancels the other request and stops later batches when a parallel request fails", async () => {
		let requests = 0;
		let cancelled = false;
		const result = await evaluateSemanticLore({
			entries: [{ enabled: true, semanticTriggers: Array.from({ length: 9 }, (_, index) => `situation ${index} ${"detail ".repeat(6000)}`) }],
			messages: [],
			settings,
			fetch: async (_input, init) => {
				if (++requests === 1) return new Response("offline", { status: 503 });
				return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => { cancelled = true; reject(new Error("Cancelled.")); }, { once: true }));
			},
		});
		expect(result).toEqual({ available: false, threshold: 0.5, fallbackReason: "Decision Model request failed with HTTP 503." });
		expect(requests).toBe(2);
		expect(cancelled).toBe(true);
	});

	test("keeps semantic matches when an empty saved message enters the scan window", async () => {
		const result = await evaluateSemanticLore({
			entries: [entry],
			messages: [{ id: 1, content: "" }, { id: 2, content: "A ship arrives." }],
			settings,
			fetch: async () => Response.json({ answers: { trigger_0: { type: "noul", noul: 0.9 } } }),
		});
		expect(result).toEqual({ available: true, threshold: 0.5, matches: [{ trigger: "ships arrive", score: 0.9 }] });
	});
});
