import { afterEach, describe, expect, test } from "bun:test";

const originalFetch = globalThis.fetch;
Object.defineProperty(globalThis, "window", {
	configurable: true,
	// SAFETY: the test supplies the minimal browser location read by Eden.
	value: { location: { origin: "http://localhost" } } as Window,
});
const { loadActiveGenerationDetails } = await import("./conversation");

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const installFetch = (handler: FetchHandler): void => {
	globalThis.fetch = Object.assign(handler, { preconnect: () => {} });
};

afterEach(() => {
	globalThis.fetch = originalFetch;
});

const retainedInspection = (status: "active" | "complete" | "length-limited" | "interrupted") => ({
	conversationId: 3,
	generationId: 7,
	messageId: 11,
	variantId: 13,
	startedAt: "2026-08-27T00:00:00.000Z",
	status,
	intent: { type: "continuation", strategy: "instruction" },
	participants: {
		human: { id: 17, name: "Writer" },
		model: { id: 19, name: "Maren" },
	},
	promptPlan: { blocks: [{ kind: "history", content: "Retained context." }], warnings: [] },
	historyRoles: ["human"],
	generationSettings: { modelId: "test-model" },
	connection: { profileId: 23 },
	budget: {
		tokenEstimate: 40,
		responseBudget: 64,
		safetyAllowance: 5,
		contextLimit: 128,
		totalRequiredTokens: 109,
		omittedHistory: [],
	},
	checkpoint: {
		content: "Retained output.",
		reasoning: "",
		latestEventId: 4,
		checkpointedAt: "2026-08-27T00:00:01.000Z",
	},
});

describe("Generation details client", () => {
	for (const status of ["complete", "length-limited", "interrupted"] as const) {
		test(`loads a retained ${status} inspection during replay`, async () => {
			installFetch(async () => Response.json(retainedInspection(status)));

			expect(await loadActiveGenerationDetails(3, 7)).toEqual({
				status: "available",
				details: retainedInspection(status),
			});
		});
	}

	test("maps an expired retained inspection to not-found", async () => {
		installFetch(async () => Response.json({ outcome: "not-found" }, { status: 404 }));

		expect(await loadActiveGenerationDetails(3, 7)).toEqual({ status: "not-found" });
	});
});
