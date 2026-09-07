import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createConnectionSettingsModule } from "../connection-settings";
import { createConversationModule } from "../conversation";
import { createConversationRoutes } from "./conversation";
import { createPromptPresetRoutes } from "./prompt-preset-routes";
import type { ModelFetch } from "../model-client";
import type {
	SillyTavernImportApplied,
	SillyTavernImportPreview,
	SillyTavernJsonValue,
} from "../../shared/contract/prompt-preset";

type ImportError = { outcome: "invalid"; reason: string };
interface ImportRequest {
	source: SillyTavernJsonValue;
	orderListId?: string;
}

interface CapturedGenerationRequest {
	messages: { role: string; content: string }[];
}

interface ConversationRevision {
	revision: number;
}

interface AcceptedGeneration {
	generationId: number;
}

const readSillyTavernSample = async (path: string): Promise<SillyTavernJsonValue> => {
	// ==[HUMAN APPROVED]== SAFETY: the supplied sample files are JSON documents; the public route
	// performs the authoritative shape validation again before conversion.
	return await Bun.file(path).json() as SillyTavernJsonValue;
};

const postReview = async (
	app: ReturnType<typeof createPromptPresetRoutes>,
	source: SillyTavernJsonValue,
	orderListId?: string,
): Promise<{ status: number; body: SillyTavernImportPreview | ImportError }> => {
	const request: ImportRequest = { source };
	if (orderListId !== undefined) request.orderListId = orderListId;
	const response = await app.handle(new Request("http://localhost/api/prompt-presets/import/sillytavern/review", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(request),
	}));
	// ==[HUMAN APPROVED]== SAFETY: the route response is the declared preview or invalid outcome.
	return { status: response.status, body: await response.json() as SillyTavernImportPreview | ImportError };
};

const postImport = async (
	app: ReturnType<typeof createPromptPresetRoutes>,
	source: SillyTavernJsonValue,
	orderListId?: string,
): Promise<{ status: number; body: SillyTavernImportApplied | ImportError }> => {
	const request: ImportRequest = { source };
	if (orderListId !== undefined) request.orderListId = orderListId;
	const response = await app.handle(new Request("http://localhost/api/prompt-presets/import/sillytavern", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(request),
	}));
	// ==[HUMAN APPROVED]== SAFETY: the route response is the declared applied or invalid outcome.
	return { status: response.status, body: await response.json() as SillyTavernImportApplied | ImportError };
};

const isPreview = (body: SillyTavernImportPreview | ImportError): body is SillyTavernImportPreview =>
	"native" in body;

const isApplied = (body: SillyTavernImportApplied | ImportError): body is SillyTavernImportApplied =>
	"preset" in body;

describe("SillyTavern Prompt Preset import transport", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("reviews and commits both supplied community samples through one selected order", async () => {
		const app = createPromptPresetRoutes(database);
		const paths = [
			".sample-format/prompts/Freaky Frankenstein 5 - Internal States - Fast.json",
			".sample-format/prompts/Marinara's Spaghetti Recipe(1).json",
		];
		for (const path of paths) {
			const source = await readSillyTavernSample(path);
			const reviewed = await postReview(app, source);
			expect(reviewed.status).toBe(200);
			expect(isPreview(reviewed.body)).toBe(true);
			if (!isPreview(reviewed.body)) continue;
			expect(reviewed.body.selectedOrderId).toBe("100001");
			expect(reviewed.body.requiresOrderSelection).toBe(false);
			expect(reviewed.body.native.slots.length).toBeGreaterThan(0);
			expect(reviewed.body.native.slots.some((slot) => slot.reference === "instruction")).toBe(true);
			expect(reviewed.body.diagnostics.some((item) => item.code === "excluded-scripts")).toBe(true);

			const imported = await postImport(app, source);
			expect(imported.status).toBe(200);
			expect(isApplied(imported.body)).toBe(true);
			if (!isApplied(imported.body)) continue;
			expect(imported.body.preset.isDefault).toBe(false);
			expect(imported.body.preset.conversationCount).toBe(0);
		}
		const listed = await app.handle(new Request("http://localhost/api/prompt-presets"));
		// ==[HUMAN APPROVED]== SAFETY: the list route's payload is the authoritative library read.
		const payload = await listed.json() as { presets: { name: string }[] };
		expect(payload.presets).toHaveLength(3);
	});

	test("requires an explicit unfamiliar-list choice and keeps conflicting toggles", async () => {
		const app = createPromptPresetRoutes(database);
		const source: SillyTavernJsonValue = {
			prompts: [
				{ identifier: "enabled-by-order", name: "Order wins", content: "one", enabled: false, role: "user" },
				{ identifier: "disabled-by-order", name: "Also order", content: "two", enabled: true, role: "assistant" },
			],
			prompt_order: [
				{ character_id: 7, order: [{ identifier: "enabled-by-order", enabled: false }, { identifier: "disabled-by-order", enabled: true }] },
				{ character_id: 8, order: [{ identifier: "enabled-by-order", enabled: true }] },
			],
		};
		const ambiguous = await postReview(app, source);
		expect(ambiguous.status).toBe(200);
		expect(isPreview(ambiguous.body) && ambiguous.body.requiresOrderSelection).toBe(true);
		const committedWithoutChoice = await postImport(app, source);
		expect(committedWithoutChoice.status).toBe(422);
		const chosen = await postReview(app, source, "7");
		expect(chosen.status).toBe(200);
		expect(isPreview(chosen.body)).toBe(true);
		if (!isPreview(chosen.body)) return;
		expect(chosen.body.native.slots.map((slot) => "name" in slot ? [slot.name, slot.enabled] : [slot.reference, slot.enabled])).toEqual([
			["Order wins", false],
			["Also order", true],
		]);
	});

	test("reports absent definitions, omits markers, keeps authored built-ins and unlisted text", async () => {
		const app = createPromptPresetRoutes(database);
		const source: SillyTavernJsonValue = {
			prompts: [
				{ identifier: "main", name: "Main", content: "main", role: "system", marker: true },
				{ identifier: "jailbreak", name: "Jailbreak", content: "jailbreak", role: "user", marker: true },
				{ identifier: "charPersonality", name: "Personality", content: "duplicate", marker: true },
				{ identifier: "worldInfoBefore", name: "World", content: "world", marker: true },
				{ identifier: "unlisted", name: "Unlisted", content: "later", role: "assistant" },
			],
			prompt_order: [{ character_id: 100001, order: [
				{ identifier: "main", enabled: true },
				{ identifier: "jailbreak", enabled: true },
				{ identifier: "charPersonality", enabled: true },
				{ identifier: "worldInfoBefore", enabled: true },
				{ identifier: "missing", enabled: true },
			] }],
		};
		const reviewed = await postReview(app, source);
		expect(reviewed.status).toBe(200);
		if (!isPreview(reviewed.body)) return;
		expect(reviewed.body.native.slots).toEqual([
			{ reference: "instruction", enabled: true, role: "system", name: "Main", content: "main" },
			{ reference: "instruction", enabled: true, role: "user", name: "Jailbreak", content: "jailbreak" },
			{ reference: "instruction", enabled: false, role: "assistant", name: "Unlisted", content: "later" },
		]);
		expect(reviewed.body.diagnostics.map((item) => item.code)).toEqual([
			"unsupported-placeholder",
			"unsupported-placeholder",
			"missing-definition",
		]);
	});

	test("reports every excluded settings family without importing its behavior", async () => {
		const app = createPromptPresetRoutes(database);
		const source: SillyTavernJsonValue = {
			prompts: [{ identifier: "main", name: "Main", content: "main", role: "system" }],
			prompt_order: [{ character_id: 100001, order: [{ identifier: "main", enabled: true }] }],
			temperature: 0.7,
			model: "remote-model",
			tools: ["web"],
			regex_scripts: [{ name: "rewrite" }],
		};
		const reviewed = await postReview(app, source);
		expect(reviewed.status).toBe(200);
		if (!isPreview(reviewed.body)) return;
		expect(reviewed.body.diagnostics.map((item) => item.code)).toEqual([
			"excluded-generation-settings",
			"excluded-model-settings",
			"excluded-tool-settings",
			"excluded-scripts",
		]);
	});

	test("translates executable names, preserves comments and converts depth placement", async () => {
		const app = createPromptPresetRoutes(database);
		const source: SillyTavernJsonValue = {
			prompts: [
				{ identifier: "before", name: "Before", content: "{{user}} {{// hidden {{char}} }} \\{{char}}", role: "user", injection_position: 0 },
				{ identifier: "chatHistory", name: "History", content: "", marker: true },
				{ identifier: "depth-one", name: "Depth one", content: "one", role: "system", injection_position: 1 },
				{ identifier: "depth-two", name: "Depth two", content: "two", role: "assistant", injection_position: 1 },
			],
			prompt_order: [{ character_id: 100001, order: [
				{ identifier: "before", enabled: true },
				{ identifier: "depth-one", enabled: false },
				{ identifier: "chatHistory", enabled: true },
				{ identifier: "chatHistory", enabled: false },
				{ identifier: "depth-two", enabled: true },
			] }],
		};
		const reviewed = await postReview(app, source);
		expect(reviewed.status).toBe(200);
		if (!isPreview(reviewed.body)) return;
		expect(reviewed.body.native.slots.map((slot) => slot.reference === "instruction" ? slot.content : slot.reference)).toEqual([
			"{{self}} {{// hidden {{char}} }} \\{{char}}",
			"history",
			"history",
			"one",
			"two",
		]);
		expect(reviewed.body.native.slots.map((slot) => slot.enabled)).toEqual([true, true, false, false, true]);
		expect(reviewed.body.diagnostics.some((item) => item.code === "depth-placement")).toBe(true);

		const noHistory: SillyTavernJsonValue = {
			prompts: [{ identifier: "depth", name: "Depth", content: "depth", role: "system", injection_position: 1 }],
			prompt_order: [{ character_id: 100001, order: [{ identifier: "depth", enabled: true }] }],
		};
		const noHistoryReview = await postReview(app, noHistory);
		expect(noHistoryReview.status).toBe(200);
		expect(isPreview(noHistoryReview.body) && noHistoryReview.body.diagnostics.some((item) => item.message.includes("no history slot"))).toBe(true);
	});

	test("a committed imported recipe survives selection and reaches the captured model request", async () => {
		const library = createPromptPresetRoutes(database);
		const conversation = createConversationModule(database).create({
			name: "Imported preset chat",
			participants: [
				{ definition: { name: "Writer", prompt: { systemInstruction: "Human", identity: "Human", scenario: "", exampleDialogue: "", postHistoryInstruction: "" }, openings: [] } },
				{ definition: { name: "Maren", prompt: { systemInstruction: "Model", identity: "Model", scenario: "", exampleDialogue: "", postHistoryInstruction: "" }, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		const source: SillyTavernJsonValue = {
			prompts: [{ identifier: "main", name: "Imported voice", content: "Speak for {{user}} to {{char}}.", role: "assistant" }],
			prompt_order: [{ character_id: 100001, order: [{ identifier: "main", enabled: true }] }],
		};
		const imported = await postImport(library, source);
		expect(imported.status).toBe(200);
		if (!isApplied(imported.body)) return;

		const key = new Uint8Array(32).fill(19);
		createConnectionSettingsModule(database, { masterKey: key }).createProfile({
			expectedRevision: 0,
			profile: {
				displayName: "Test provider",
				apiFormat: "chat-completions",
				requestUrl: "http://127.0.0.1:43131/v1/",
				modelsUrl: "",
				modelBackend: "automatic",
				adapter: "deepseek",
				outputTokenRepresentation: "automatic",
				timeoutMs: 120_000,
				pinnedModels: [],
			},
			credential: "test-secret",
		});
		const conversations = createConversationRoutes(database, {
			masterKey: key,
			fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
				// ==[HUMAN APPROVED]== SAFETY: the conversation route sends this exact JSON request body
				// to the configured ModelFetch implementation.
				captured = JSON.parse(String(init?.body)) as CapturedGenerationRequest;
				return new Response("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Done.\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
			}) satisfies ModelFetch,
		});
		let captured: CapturedGenerationRequest = { messages: [] };
		const selected = await conversations.handle(new Request(`http://localhost/api/conversations/${conversation.id}/commands`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ expectedRevision: conversation.revision, action: { type: "select-prompt-preset", promptPresetId: imported.body.preset.id } }),
		}));
		expect(selected.status).toBe(200);
		const latest = await conversations.handle(new Request(`http://localhost/api/conversations/${conversation.id}`));
		// ==[HUMAN APPROVED]== SAFETY: this GET response is the conversation route's declared snapshot.
		const latestBody = await latest.json() as ConversationRevision;
		const accepted = await conversations.handle(new Request(`http://localhost/api/conversations/${conversation.id}/generations`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ expectedRevision: latestBody.revision, content: "Set the scene." }),
		}));
		expect(accepted.status).toBe(200);
		// ==[HUMAN APPROVED]== SAFETY: this POST response is the conversation route's declared generation.
		const acceptedBody = await accepted.json() as AcceptedGeneration;
		const events = await conversations.handle(new Request(`http://localhost/api/conversations/${conversation.id}/generations/${acceptedBody.generationId}/events`));
		await events.text();
		expect(captured.messages).toContainEqual({ role: "assistant", content: "Speak for Writer to Maren." });
	});
});
