import { afterEach, describe, expect, test } from "bun:test";
import { flushHook, renderHook } from "./test-fixtures/render-hook";
import { QueryClient, onlineManager } from "@tanstack/react-query";
import type { ConversationSummary, GenerationPreview } from "./conversation";
import type { PromptPlan } from "../shared/contract/conversation-schema";
import type { GenerationAttemptTarget } from "../shared/contract/generation-events";
import type { SetStateAction } from "react";

const { useAssemblyController } = await import("./workspace/useAssemblyController");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; onlineManager.setOnline(true); });
const plan = (content: string): PromptPlan => ({ blocks: [{ kind: "instruction", role: "system", content }], warnings: [], images: [] });
const preview = (conversationId = 7, content = "Expanded"): GenerationPreview => ({
	outcome: "available", previewId: "preview-1", conversationId, kind: "send", promptPlan: plan(content),
	participants: { human: null, model: null }, pendingWrites: [], memorySources: { messageIds: [], variantIds: [] },
	effectiveSettings: {
		modelId: "model", temperature: null, topP: null, frequencyPenalty: null, presencePenalty: null,
		contextLimit: 10, responseBudget: 1, safetyAllowance: 1, siblingGenerationLimit: null,
		continuationStrategy: null, continuationInstruction: null, continuationPrefillSuffix: null,
		repeatedImagePlacement: "first", requestOverrides: {},
	},
	budget: { tokenEstimate: 1, responseBudget: 1, safetyAllowance: 1, contextLimit: 10, totalRequiredTokens: 3, budgetFits: true },
});
const conversation = (id = 7) => {
	// SAFETY: the assembly hook only reads id, revision, and playable; the fixture supplies that boundary.
	return { id, revision: 2, playable: true } as ConversationSummary;
};
const accepted = { outcome: "accepted", conversationId: 7, generationId: 10, messageId: 20, variantId: 30 } as const;

type Request = { url: string; init?: RequestInit };
async function assemblyHarness(handler: (request: Request) => Promise<Response>, strict = false) {
	const requests: Request[] = [];
	globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
		const request = { url: String(input), init };
		requests.push(request);
		return handler(request);
	}, { preconnect() {} });
	const cache = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
	const effects: string[] = [];
	const targets: GenerationAttemptTarget[] = [];
	const options = {
		conversation: conversation(), activeChatIdRef: { current: "7" },
		ensureLatest: async () => options.conversation,
		refreshStory: async (_id: number) => { effects.push("refresh"); return options.conversation; },
		isGenerating: false, variantPreviewActive: false, inspectPromptPlanBeforeGenerating: true,
		generationStart: {
			begin: () => { effects.push("begin"); return 1; },
			settle: (_id: number) => { effects.push("settle"); },
			accepted: (_id: number, target: GenerationAttemptTarget) => { effects.push("accepted"); targets.push(target); },
		},
		dispatchStory: () => {},
		draft: "Draft",
		setDraft: (draft: SetStateAction<string>) => { if (draft === "") effects.push("clear"); },
	};
	const hook = await renderHook(() => useAssemblyController(options), cache, strict);
	const open = async (content = "Draft") => {
		await hook.act(async () => hook.current.requestGeneration({ kind: "send", content }));
		await flushHook();
		await flushHook();
	};
	const switchTo = async (id: number) => {
		await hook.act(async () => {
			hook.current.conversationSwitched();
			options.activeChatIdRef.current = String(id);
			options.conversation = conversation(id);
		});
		await hook.rerender();
	};
	return { hook, cache, effects, targets, requests, options, open, switchTo };
}

describe("assembly session", () => {
	test("acceptance sends the edited plan once and closes on success", async () => {
		const response = Promise.withResolvers<Response>();
		const h = await assemblyHarness(({ url }) => url.endsWith("/preview") ? Promise.resolve(Response.json(preview())) : response.promise);
		await h.open();
		await h.hook.act(async () => h.hook.current.editPromptPlanPreview(plan("Edited")));
		await flushHook();
		await h.hook.act(async () => {
			h.hook.current.sendPromptPlanPreview();
			h.hook.current.sendPromptPlanPreview();
		});
		const starts = h.requests.filter(({ url }) => !url.endsWith("/preview"));
		expect(starts).toHaveLength(1);
		expect(JSON.parse(String(starts[0]?.init?.body))).toMatchObject({ expectedRevision: 2, promptPlan: plan("Edited") });
		await h.hook.act(async () => response.resolve(Response.json(accepted)));
		await flushHook();
		expect(h.hook.current.assembly).toBeNull();
		expect(h.effects).toEqual(["begin", "clear", "refresh", "accepted"]);
		expect(h.targets).toEqual([accepted]);
	});

	test("reopening the same request assembles a fresh plan", async () => {
		let count = 0;
		const h = await assemblyHarness(async () => Response.json(preview(7, ++count === 1 ? "First" : "Fresh")));
		await h.open();
		await h.hook.act(async () => h.hook.current.editPromptPlanPreview(plan("Edited")));
		await flushHook();
		await h.hook.act(async () => h.hook.current.cancelPromptPlanPreview());
		await h.open();
		expect(h.hook.current.assembly?.preview?.promptPlan).toEqual(plan("Fresh"));
		expect(count).toBe(2);
	});

	test("an edited plan survives reconnect; explicit Refresh replaces it", async () => {
		const h = await assemblyHarness(async () => Response.json(preview()));
		await h.open();
		await h.hook.act(async () => h.hook.current.editPromptPlanPreview(plan("Edited")));
		await flushHook();
		await h.hook.act(async () => { onlineManager.setOnline(false); onlineManager.setOnline(true); });
		await flushHook();
		expect(h.hook.current.assembly?.preview?.promptPlan).toEqual(plan("Edited"));
		expect(h.requests).toHaveLength(1);
		await h.hook.act(async () => h.hook.current.refreshPromptPlanPreview());
		await flushHook();
		expect(h.hook.current.assembly?.preview?.promptPlan).toEqual(plan("Expanded"));
		expect(h.requests).toHaveLength(2);
	});

	test("an edited plan survives acceptance failure and is sent again on retry", async () => {
		let starts = 0;
		const h = await assemblyHarness(async ({ url }) => url.endsWith("/preview") ? Response.json(preview())
			: ++starts === 1 ? Response.json({ outcome: "invalid", reason: "Start failed." }, { status: 422 }) : Response.json(accepted));
		await h.open();
		await h.hook.act(async () => h.hook.current.editPromptPlanPreview(plan("Edited")));
		await flushHook();
		await h.hook.act(async () => h.hook.current.sendPromptPlanPreview());
		await flushHook();
		expect(h.hook.current.assembly?.phase).toBe("failed");
		expect(h.hook.current.assembly?.error).toBe("Start failed.");
		expect(h.hook.current.assembly?.preview?.promptPlan).toEqual(plan("Edited"));
		await h.hook.act(async () => h.hook.current.sendPromptPlanPreview());
		await flushHook();
		expect(h.hook.current.assembly).toBeNull();
		expect(h.requests.filter(({ url }) => !url.endsWith("/preview")).map(({ init }) => JSON.parse(String(init?.body)).promptPlan))
			.toEqual([plan("Edited"), plan("Edited")]);
	});

	test("cancel closes the preview, aborts its read, and rejects a late response", async () => {
		const response = Promise.withResolvers<Response>();
		const h = await assemblyHarness(() => response.promise);
		await h.open();
		expect(h.hook.current.assembly?.phase).toBe("assembling");
		const signal = h.requests[0]?.init?.signal;
		await h.hook.act(async () => h.hook.current.cancelPromptPlanPreview());
		expect(signal?.aborted).toBe(true);
		await h.hook.act(async () => response.resolve(Response.json(preview())));
		await flushHook();
		expect(h.hook.current.assembly).toBeNull();
		expect(h.effects).toEqual([]);
	});

	test("conversation switch closes the preview and rejects the older read", async () => {
		const response = Promise.withResolvers<Response>();
		const h = await assemblyHarness(({ url }) => url.includes("/7/") ? response.promise : Promise.resolve(Response.json(preview(8, "New Chat"))));
		await h.open();
		const signal = h.requests[0]?.init?.signal;
		await h.switchTo(8);
		expect(h.hook.current.assembly).toBeNull();
		expect(signal?.aborted).toBe(true);
		await h.open();
		await h.hook.act(async () => response.resolve(Response.json(preview(7, "Old Chat"))));
		await flushHook();
		expect(h.hook.current.assembly?.preview?.conversationId).toBe(8);
		expect(h.hook.current.assembly?.preview?.promptPlan).toEqual(plan("New Chat"));
	});

	test("an old acceptance cannot close a new preview after A to B to A", async () => {
		const response = Promise.withResolvers<Response>();
		const h = await assemblyHarness(({ url }) => url.endsWith("/preview") ? Promise.resolve(Response.json(preview())) : response.promise);
		await h.open();
		await h.hook.act(async () => h.hook.current.sendPromptPlanPreview());
		const signal = h.requests.at(-1)?.init?.signal;
		await h.switchTo(8);
		await h.switchTo(7);
		await h.open("New Draft");
		await h.hook.act(async () => h.hook.current.editPromptPlanPreview(plan("New Plan")));
		await h.hook.act(async () => response.resolve(Response.json(accepted)));
		await flushHook();
		expect(signal?.aborted).toBe(true);
		expect(h.hook.current.assembly?.preview?.promptPlan).toEqual(plan("New Plan"));
		expect(h.effects).toEqual(["begin"]);
	});

	test("switching while acceptance waits for latest prevents the network call", async () => {
		const h = await assemblyHarness(async () => Response.json(preview()));
		await h.open();
		const latest = Promise.withResolvers<ConversationSummary>();
		h.options.ensureLatest = () => latest.promise;
		await h.hook.rerender();
		await h.hook.act(async () => h.hook.current.sendPromptPlanPreview());
		await h.switchTo(8);
		await h.switchTo(7);
		await h.hook.act(async () => latest.resolve(conversation()));
		await flushHook();
		expect(h.requests).toHaveLength(1);
		expect(h.effects).toEqual(["begin"]);
	});

	test("switching during the accepted story refresh suppresses acceptance reporting", async () => {
		const h = await assemblyHarness(async ({ url }) => Response.json(url.endsWith("/preview") ? preview() : accepted));
		await h.open();
		const refreshed = Promise.withResolvers<ConversationSummary>();
		h.options.refreshStory = async () => { h.effects.push("refresh"); return refreshed.promise; };
		await h.hook.rerender();
		await h.hook.act(async () => h.hook.current.sendPromptPlanPreview());
		await flushHook();
		expect(h.effects).toEqual(["begin", "clear", "refresh"]);
		await h.switchTo(8);
		await h.switchTo(7);
		await h.hook.act(async () => refreshed.resolve(conversation()));
		await flushHook();
		expect(h.targets).toEqual([]);
	});

	test("preparation cannot reopen a preview after its owner unmounts", async () => {
		const h = await assemblyHarness(async () => Response.json(preview()));
		const latest = Promise.withResolvers<ConversationSummary>();
		h.options.ensureLatest = () => latest.promise;
		await h.hook.rerender();
		await h.hook.act(async () => h.hook.current.requestGeneration({ kind: "send", content: "Draft" }));
		await h.hook.unmount();
		await h.hook.act(async () => latest.resolve(conversation()));
		await flushHook();
		expect(h.requests).toEqual([]);
		expect(h.effects).toEqual([]);
	});

	test("acceptance settling after unmount cannot clear the draft or report acceptance", async () => {
		const response = Promise.withResolvers<Response>();
		const h = await assemblyHarness(({ url }) => url.endsWith("/preview") ? Promise.resolve(Response.json(preview())) : response.promise);
		await h.open();
		expect(h.hook.current.assembly?.phase).toBe("ready");
		await h.hook.act(async () => h.hook.current.sendPromptPlanPreview());
		await h.hook.unmount();
		await h.hook.act(async () => response.resolve(Response.json(accepted)));
		await flushHook();
		expect(h.effects).toEqual(["begin"]);
	});
});
