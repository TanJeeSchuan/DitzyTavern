import { afterEach, describe, expect, test } from "bun:test";
import type { ActiveGenerationDetails } from "../shared/contract/conversation-schema";

const originalFetch = globalThis.fetch;
Object.defineProperty(globalThis, "window", {
	configurable: true,
	// SAFETY: the test supplies the minimal browser location read by Eden.
	value: { location: { origin: "http://localhost" } } as Window,
});
const { loadActiveGenerationDetails, loadVariantDetails } = await import("./conversation");

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const installFetch = (handler: FetchHandler): void => {
	globalThis.fetch = Object.assign(handler, { preconnect: () => {} });
};

afterEach(() => {
	globalThis.fetch = originalFetch;
});

const retainedInspection = (status: ActiveGenerationDetails["status"]): ActiveGenerationDetails => ({
	conversationId: 3,
	generationId: 7,
	messageId: 11,
	variantId: 13,
	startedAt: "2026-08-27T00:00:00.000Z",
	status,
	intent: { type: "continuation", strategy: "instruction", instruction: "Continue." },
	participants: {
		human: { id: 17, name: "Writer" },
		model: { id: 19, name: "Maren" },
	},
	promptPlan: {
		blocks: [{
			kind: "history",
			speakerName: null,
			content: "Retained context.",
			role: "model",
		}],
		warnings: [],
	},
	promptContext: [{ kind: "message", speakerName: "Writer", content: "Hello", role: "human" }],
	generationSettings: { modelId: "test-model" },
	connection: { profileId: 23 },
	memorySources: [],
	budget: {
		tokenEstimate: 40,
		responseBudget: 64,
		safetyAllowance: 5,
		contextLimit: 128,
		totalRequiredTokens: 109,
		omittedContext: [],
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

	test("reports a corrupt retained inspection with the server reason", async () => {
		installFetch(async () => Response.json({ outcome: "invalid", reason: "Stored Lore activation evidence is invalid." }, { status: 422 }));

		expect(await loadActiveGenerationDetails(3, 7)).toEqual({
			status: "invalid",
			reason: "Stored Lore activation evidence is invalid.",
		});
	});

	test("reports corrupt Variant details with the server reason", async () => {
		installFetch(async () => Response.json({ outcome: "invalid", reason: "Stored Lore activation evidence is invalid." }, { status: 422 }));

		expect(await loadVariantDetails(3, 11, 13)).toEqual({
			status: "invalid",
			reason: "Stored Lore activation evidence is invalid.",
		});
	});
});
