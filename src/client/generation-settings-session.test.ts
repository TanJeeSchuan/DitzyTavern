import { afterEach, expect, test } from "bun:test";
import { QueryClient, onlineManager } from "@tanstack/react-query";
import { flushHook, renderHook } from "./test-fixtures/render-hook";
import type { ConversationGenerationSettings, ConversationSummary } from "./conversation";

const { useGenerationSettingsDraft } = await import("./workspace/useGenerationSettingsDraft");
const { useGenerationSettingsQuery, publishGenerationSettings } = await import("./generation-settings-query");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; onlineManager.setOnline(true); });
const summary = (id = 1, revision = 5): ConversationSummary => ({
	id, revision, name: "Chat", authorNote: "", cast: [], control: { humanParticipantId: null, modelParticipantId: null },
	controlValidity: { valid: false, reason: "missing-seat" }, playable: false,
	capabilities: { compose: { available: false, reason: "conversation-not-playable" },
		generate: { available: false, reason: "conversation-not-playable" },
		swipe: { available: false, reason: "conversation-not-playable" } }, activeGenerations: [],
});
const settings = (instruction = "Original"): ConversationGenerationSettings => ({
	connectionProfileId: 7, modelId: "model", temperature: null, topP: null, frequencyPenalty: null, presencePenalty: null,
	contextLimit: 32768, responseBudget: 1024, safetyAllowance: 500, siblingGenerationLimit: 4,
	continuationStrategy: "instruction", continuationInstruction: instruction, continuationPrefillSuffix: "", repeatedImagePlacement: "last",
	requestOverrides: { "chat-completions": {}, responses: {}, "anthropic-messages": {} },
});
type Request = { url: string; init?: RequestInit };
async function harness(handler: (request: Request) => Promise<Response>, strict = false) {
	const requests: Request[] = [];
	globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
		const request = { url: String(input), init }; requests.push(request); return handler(request);
	}, { preconnect() {} });
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
	const changes: ConversationSummary[] = [];
	const options = { conversation: summary(), onConversationChange: (next: ConversationSummary | null) => { if (next) { changes.push(next); options.conversation = next; } } };
	const hook = await renderHook(() => useGenerationSettingsDraft(options), client, strict);
	await flushHook();
	return { hook, client, requests, changes, options, switchTo: async (id: number) => { options.conversation = summary(id); await hook.rerender(); await flushHook(); } };
}

test("switching Conversation aborts the old read and never adopts its late settings", async () => {
	const response = Promise.withResolvers<Response>();
	const h = await harness(({ url }) => url.includes("/1/") ? response.promise : Promise.resolve(Response.json(settings("Second"))));
	const signal = h.requests[0]?.init?.signal;
	await h.switchTo(2);
	expect(signal?.aborted).toBe(true);
	await h.hook.act(async () => response.resolve(Response.json(settings("Late"))));
	await flushHook();
	expect(h.hook.current.instruction).toBe("Second");
	expect(h.hook.current.settings?.continuationInstruction).toBe("Second");
});

test("StrictMode, 21 readers, rerenders and reconnect share one read; a panel save reaches every reader", async () => {
	const h = await harness(async ({ init }) => init?.method === "POST" ? Response.json({ outcome: "applied", conversation: summary(1, 6) }) : Response.json(settings()), true);
	const readers = await renderHook(() => Array.from({ length: 21 }, () => useGenerationSettingsQuery(h.options.conversation)), h.client, true);
	for (let i = 0; i < 5; i++) { await h.hook.rerender(); await readers.rerender(); }
	expect(h.requests).toHaveLength(1);
	await h.hook.act(async () => h.hook.current.updateInstruction("Saved"));
	await h.hook.act(async () => { onlineManager.setOnline(false); onlineManager.setOnline(true); });
	await flushHook();
	expect(h.hook.current.instruction).toBe("Saved");
	expect(h.requests).toHaveLength(1);
	await h.hook.act(async () => { expect(await h.hook.current.save()).toBe(true); });
	await flushHook();
	expect(h.requests).toHaveLength(3);
	expect(readers.current.map((read) => read.data?.continuationInstruction)).toEqual(Array(21).fill("Saved"));
	const later = await renderHook(() => useGenerationSettingsQuery(h.options.conversation), h.client);
	expect(later.current.data?.continuationInstruction).toBe("Saved");
	expect(h.requests).toHaveLength(3);
	expect(JSON.parse(String(h.requests[2]?.init?.body))).toMatchObject({ expectedRevision: 5, action: { type: "update-generation-settings", settings: { continuationInstruction: "Saved" } } });
});

for (const transition of ["unmount", "A to B to A"] as const) test(`a save settling after ${transition} cannot resurrect state or notify the Conversation owner`, async () => {
	const response = Promise.withResolvers<Response>();
	const h = await harness(({ init }) => init?.method === "POST" ? response.promise : Promise.resolve(Response.json(settings())));
	await h.hook.act(async () => h.hook.current.updateInstruction("Submitted"));
	let save: Promise<boolean> = Promise.resolve(false);
	await h.hook.act(async () => { save = h.hook.current.save(); });
	await flushHook();
	if (transition === "unmount") await h.hook.unmount();
	else { await h.switchTo(2); await h.switchTo(1); await h.hook.act(async () => h.hook.current.updateInstruction("New draft")); }
	await h.hook.act(async () => response.resolve(Response.json({ outcome: "applied", conversation: summary(1, 6) })));
	await flushHook();
	expect(await save).toBe(false);
	expect(h.changes).toEqual([]);
	if (transition !== "unmount") { expect(h.hook.current.instruction).toBe("New draft"); expect(h.hook.current.status).toBe("ready"); }
	const reader = await renderHook(() => useGenerationSettingsQuery(summary()), h.client);
	expect(reader.current.data?.continuationInstruction).toBe("Original");
});

test("ABA edits during save preserve the newer draft and prevent save-and-leave success", async () => {
	const response = Promise.withResolvers<Response>();
	const h = await harness(({ init }) => init?.method === "POST" ? response.promise : Promise.resolve(Response.json(settings())));
	await h.hook.act(async () => h.hook.current.updateInstruction("Submitted"));
	let save: Promise<boolean> = Promise.resolve(false);
	await h.hook.act(async () => { save = h.hook.current.save(); });
	await flushHook();
	await h.hook.act(async () => { h.hook.current.updateInstruction("Other"); h.hook.current.updateInstruction("Submitted"); });
	await h.hook.act(async () => response.resolve(Response.json({ outcome: "applied", conversation: summary(1, 6) })));
	await flushHook();
	expect(await save).toBe(false);
	expect(h.hook.current.instruction).toBe("Submitted");
	expect(h.hook.current.settings?.continuationInstruction).toBe("Submitted");
});

test("409 adopts the current Conversation and settings for all readers while retaining the complete draft", async () => {
	let reads = 0;
	const h = await harness(async ({ init }) => init?.method === "POST"
		? Response.json({ outcome: "conflict", expectedRevision: 5, actualRevision: 9, currentConversation: summary(1, 9) }, { status: 409 })
		: Response.json(settings(++reads <= 2 ? "Original" : "Server")));
	const other = await renderHook(() => useGenerationSettingsQuery(h.options.conversation), h.client);
	await h.hook.act(async () => { h.hook.current.updateInstruction("Local"); h.hook.current.updateSampling("temperature", "0.4"); });
	await h.hook.act(async () => { expect(await h.hook.current.save()).toBe(false); });
	await flushHook();
	expect(h.changes).toEqual([summary(1, 9)]);
	expect(h.hook.current.settings?.continuationInstruction).toBe("Server");
	expect(other.current.data?.continuationInstruction).toBe("Server");
	expect(h.hook.current.instruction).toBe("Local");
	expect(h.hook.current.samplingDrafts.temperature).toBe("0.4");
	expect(h.hook.current.problem).toContain("changed elsewhere");
	expect(JSON.parse(String(h.requests.find(({ init }) => init?.method === "POST")?.init?.body)).expectedRevision).toBe(5);
});

test("a late background read cannot roll back a newer authoritative write", async () => {
	const late = Promise.withResolvers<Response>();
	let reads = 0;
	const h = await harness(() => ++reads === 1 ? Promise.resolve(Response.json(settings())) : late.promise);
	await h.hook.act(async () => { void h.client.invalidateQueries({ queryKey: ["generation-settings", 1] }); });
	const signal = h.requests[1]?.init?.signal;
	await h.hook.act(async () => { publishGenerationSettings(h.client, summary(1, 8), settings("New authority")); });
	expect(signal?.aborted).toBe(true);
	await h.hook.act(async () => late.resolve(Response.json(settings("Old authority"))));
	await flushHook();
	expect(h.hook.current.settings?.continuationInstruction).toBe("New authority");
	expect(h.hook.current.instruction).toBe("New authority");
});

test("late panel save cannot replace a newer saved view", async () => {
	const late = Promise.withResolvers<Response>();
	const h = await harness(({ init }) => init?.method === "POST" ? late.promise : Promise.resolve(Response.json(settings())));
	await h.hook.act(async () => h.hook.current.updateInstruction("Submitted at six"));
	let saving = Promise.resolve(false);
	await h.hook.act(async () => { saving = h.hook.current.save(); });
	await flushHook();
	h.options.conversation = summary(1, 7);
	await h.hook.rerender();
	await h.hook.act(async () => publishGenerationSettings(h.client, summary(1, 7), settings("Authority at seven")));
	await flushHook();
	await h.hook.act(async () => { late.resolve(Response.json({ outcome: "applied", conversation: summary(1, 6) })); await saving; });
	await flushHook();
	expect(h.hook.current.settings?.continuationInstruction).toBe("Authority at seven");
	expect(h.hook.current.instruction).toBe("Submitted at six");
	expect(h.hook.current.dirty).toBe(true);
	expect(await saving).toBe(false);
	expect(h.changes).toEqual([]);
});
const { ModelSelector } = await import("./ModelSelector");
const profile = { id: 7, displayName: "Connection", apiFormat: "chat-completions", baseUrl: "http://localhost", apiKey: "", isActive: true, streamInactivityTimeout: 0 };
const modelSelect = (element: ReturnType<typeof ModelSelector>) => element.props.children[0].props.onSelect;
test("ModelSelector conflict refreshes cached settings for later readers", async () => {
	let current = summary();
	let serverModel = "model";
	globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
		if (init?.method === "POST") {
			serverModel = "server-model";
			return Response.json({ outcome: "conflict", expectedRevision: 5, actualRevision: 9, currentConversation: summary(1, 9) }, { status: 409 });
		}
		if (String(input).includes("connection-settings"))
			return Response.json({ revision: 1, profiles: [], presets: [] });
		return Response.json({ ...settings(), modelId: serverModel });
	}, { preconnect() { } });
	const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const options = () => ({ conversation: current, onConversationChange: (next: ConversationSummary) => { current = next; } });
	const hook = await renderHook(() => ModelSelector(options()), cache);
	await flushHook();
	await hook.act(async () => { await modelSelect(hook.current)(profile, "chosen-model"); });
	await hook.rerender();
	await flushHook();
	await hook.unmount();
	const later = await renderHook(() => ModelSelector(options()), cache);
	await flushHook();
	expect(later.current.props.children[0].props.selected.modelId).toBe("server-model");
});
test("ModelSelector pending write cannot publish after unmount", async () => {
	const late = Promise.withResolvers<Response>();
	globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
		if (init?.method === "POST")
			return late.promise;
		if (String(input).includes("connection-settings"))
			return Response.json({ revision: 1, profiles: [], presets: [] });
		return Response.json(settings());
	}, { preconnect() { } });
	const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const changes: ConversationSummary[] = [];
	const hook = await renderHook(() => ModelSelector({ conversation: summary(), onConversationChange: x => changes.push(x) }), cache);
	await flushHook();
	let saving = Promise.resolve();
	await hook.act(async () => { saving = modelSelect(hook.current)(profile, "new-model"); });
	await flushHook();
	await hook.unmount();
	await hook.act(async () => { late.resolve(Response.json({ outcome: "applied", conversation: summary(1, 6) })); await saving; });
	await flushHook();
	expect(changes).toEqual([]);
	expect(cache.getQueryData<{
		settings: ConversationGenerationSettings;
	}>(["generation-settings", 1])?.settings.modelId).toBe("model");
});
test("ModelSelector key switch rejects old Conversation completion", async () => {
	const late = Promise.withResolvers<Response>();
	globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
		if (init?.method === "POST")
			return late.promise;
		if (String(input).includes("connection-settings"))
			return Response.json({ revision: 1, profiles: [], presets: [] });
		return Response.json(settings());
	}, { preconnect() { } });
	let current = summary();
	const changes: ConversationSummary[] = [];
	const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const hook = await renderHook(() => ModelSelector({ conversation: current, onConversationChange: x => changes.push(x) }), cache);
	await flushHook();
	let saving = Promise.resolve();
	await hook.act(async () => { saving = modelSelect(hook.current)(profile, "new-model"); });
	await flushHook();
	current = summary(2);
	await hook.rerender();
	await flushHook();
	await hook.act(async () => { late.resolve(Response.json({ outcome: "applied", conversation: summary(1, 6) })); await saving; });
	await flushHook();
	expect(changes).toEqual([]);
});
