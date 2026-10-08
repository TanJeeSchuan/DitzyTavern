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
import {
	captureModelFetch,
	completeGeneration,
	createChat,
	exportPreset,
	importPreset as importNativePreset,
	key,
	readConversation,
	readOperation,
	readPreset,
	selectPreset,
	startGeneration,
	toggleBlock,
	withProfile,
} from "./prompt-preset-test-fixtures";

import { observeConversationWrites } from "../conversation";
import { syncMemorySources } from "../memory";
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

// These compact sources intentionally stay with the transport tests. They represent the
// supported import behavior without depending on ignored samples or network downloads.
const samples: Array<{
	source: SillyTavernJsonValue;
	expectedContentInOrder: readonly [string, string];
	expectedReferences: Array<SillyTavernImportPreview["native"]["slots"][number]["reference"]>;
}> = [
	{
		source: {
			name: "Tracked Internal States",
			prompts: [
				{ identifier: "main", name: "Prose rules", content: "All prose rules DO_NOT apply to spoken NPC dialogue.", role: "system" },
				{ identifier: "charDescription", name: "Character", content: "Model identity source.", role: "assistant" },
				{ identifier: "personaDescription", name: "Writer", content: "The writer observes carefully.", role: "user" },
				{ identifier: "scenario", name: "Scene", content: "The room is quiet.", role: "system" },
				{ identifier: "dialogueExamples", name: "Examples", content: "Writer: Hello\nMaren: Hello back", role: "user" },
				{ identifier: "chatHistory", name: "History", content: "", marker: true },
				{ identifier: "tail", name: "Tail", content: "Describe characters/scenery in 3rd person limited.", role: "system" },
			],
			prompt_order: [{ character_id: 100001, order: [
				{ identifier: "main", enabled: true },
				{ identifier: "charDescription", enabled: true },
				{ identifier: "personaDescription", enabled: true },
				{ identifier: "scenario", enabled: true },
				{ identifier: "dialogueExamples", enabled: true },
				{ identifier: "chatHistory", enabled: true },
				{ identifier: "tail", enabled: true },
			] }],
			regex_scripts: [],
		},
		expectedContentInOrder: [
			"All prose rules DO_NOT apply to spoken NPC dialogue.",
			"Describe characters/scenery in 3rd person limited.",
		],
		expectedReferences: [
			"instruction",
			"model-identity",
			"human-identity",
			"model-scenario",
			"model-example-dialogue",
			"history",
			"instruction",
		],
	},
	{
		source: {
			name: "Tracked Macro Recipe",
			prompts: [
				{ identifier: "main", name: "Prompt variables", content: "{{setvar::prompt::an excellent protagonist.", role: "system" },
				{ identifier: "jailbreak", name: "Tense", content: "{{setvar::tense::past tense}} Tense enabled.", role: "user" },
				{ identifier: "chatHistory", name: "History", content: "", marker: true },
			],
			prompt_order: [{ character_id: 100001, order: [
				{ identifier: "main", enabled: true },
				{ identifier: "jailbreak", enabled: true },
				{ identifier: "chatHistory", enabled: true },
			] }],
			regex_scripts: [{ name: "preserved diagnostic source" }],
		},
		expectedContentInOrder: [
			"{{setvar::prompt::an excellent protagonist.",
			"Tense enabled.",
		],
		expectedReferences: ["instruction", "instruction", "history"],
	},
];

const importRequest = (source: SillyTavernJsonValue, orderListId?: string): ImportRequest => {
	const request: ImportRequest = { source };
	if (orderListId !== undefined) request.orderListId = orderListId;
	return request;
};

const postReview = async (
	app: ReturnType<typeof createPromptPresetRoutes>,
	source: SillyTavernJsonValue,
	orderListId?: string,
): Promise<{ status: number; body: SillyTavernImportPreview | ImportError }> => {
	const response = await app.handle(new Request("http://localhost/api/prompt-presets/import/sillytavern/review", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(importRequest(source, orderListId)),
	}));
	// ==[HUMAN APPROVED]== SAFETY: the route response is the declared preview or invalid outcome.
	return { status: response.status, body: await response.json() as SillyTavernImportPreview | ImportError };
};

const postImport = async (
	app: ReturnType<typeof createPromptPresetRoutes>,
	source: SillyTavernJsonValue,
	orderListId?: string,
): Promise<{ status: number; body: SillyTavernImportApplied | ImportError }> => {
	const response = await app.handle(new Request("http://localhost/api/prompt-presets/import/sillytavern", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(importRequest(source, orderListId)),
	}));
	// ==[HUMAN APPROVED]== SAFETY: the route response is the declared applied or invalid outcome.
	return { status: response.status, body: await response.json() as SillyTavernImportApplied | ImportError };
};

const isPreview = (body: SillyTavernImportPreview | ImportError): body is SillyTavernImportPreview =>
	"native" in body;

const isApplied = (body: SillyTavernImportApplied | ImportError): body is SillyTavernImportApplied =>
	"preset" in body;

const requirePreview = (body: SillyTavernImportPreview | ImportError): SillyTavernImportPreview => {
	expect(isPreview(body)).toBe(true);
	if (!isPreview(body)) throw new Error("Expected a SillyTavern import preview.");
	return body;
};

const requireApplied = (body: SillyTavernImportApplied | ImportError): SillyTavernImportApplied => {
	expect(isApplied(body)).toBe(true);
	if (!isApplied(body)) throw new Error("Expected an applied SillyTavern import.");
	return body;
};

describe("SillyTavern Prompt Preset import transport", () => {
	let database: Database;

	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
		observeConversationWrites(database, syncMemorySources);
	});
	afterEach(() => database.close());

	test("reviews and commits both tracked samples through one selected order", async () => {
		const app = createPromptPresetRoutes(database);
		for (const { source, expectedReferences } of samples) {
			const reviewed = await postReview(app, source);
			expect(reviewed.status).toBe(200);
			const preview = requirePreview(reviewed.body);
			expect(preview.selectedOrderId).toBe("100001");
			expect(preview.requiresOrderSelection).toBe(false);
			expect(preview.native.slots.length).toBeGreaterThan(0);
			expect(preview.native.slots.some((slot) => slot.reference === "instruction")).toBe(true);
			expect(preview.native.slots.map((slot) => slot.reference)).toEqual(expectedReferences);
			expect(preview.diagnostics.some((item) => item.code === "excluded-scripts")).toBe(true);

			const imported = await postImport(app, source);
			expect(imported.status).toBe(200);
			const applied = requireApplied(imported.body);
			expect(applied.preset.isDefault).toBe(false);
			expect(applied.preset.conversationCount).toBe(0);
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
		expect(requirePreview(ambiguous.body).requiresOrderSelection).toBe(true);
		const committedWithoutChoice = await postImport(app, source);
		expect(committedWithoutChoice.status).toBe(422);
		const chosen = await postReview(app, source, "7");
		expect(chosen.status).toBe(200);
		const chosenPreview = requirePreview(chosen.body);
		expect(chosenPreview.native.slots.map((slot) => "name" in slot ? [slot.name, slot.enabled] : [slot.reference, slot.enabled])).toEqual([
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
		const preview = requirePreview(reviewed.body);
		expect(preview.native.slots).toEqual([
			{ reference: "instruction", enabled: true, role: "system", name: "Main", content: "main" },
			{ reference: "instruction", enabled: true, role: "user", name: "Jailbreak", content: "jailbreak" },
			{ reference: "lore", enabled: true, role: "system" },
			{ reference: "instruction", enabled: false, role: "assistant", name: "Unlisted", content: "later" },
		]);
		expect(preview.diagnostics.map((item) => item.code)).toEqual([
			"unsupported-placeholder",
			"missing-definition",
		]);
	});

	test("reports lossy authored normalization while preserving the first duplicate", async () => {
		const app = createPromptPresetRoutes(database);
		const source: SillyTavernJsonValue = {
			prompts: [
				{ identifier: "missing-role", name: "Missing role", content: "default me" },
				{ identifier: "unsupported-role", name: "Unsupported role", content: "default this", role: "tool" },
				{ identifier: "invalid-position", name: "Invalid position", content: "ordinary order", role: "assistant", injection_position: 2 },
				{ identifier: "duplicate", name: "First", content: "first content", role: "user" },
				{ identifier: "duplicate", name: "Later", content: "later content", role: "assistant" },
			],
			prompt_order: [{ character_id: 100001, order: [
				{ identifier: "missing-role", enabled: true },
				{ identifier: "unsupported-role", enabled: true },
				{ identifier: "invalid-position", enabled: true },
				{ identifier: "duplicate", enabled: true },
				{ identifier: "duplicate", enabled: false },
				{ identifier: "missing-role", enabled: false },
			] }],
		};
		const reviewed = await postReview(app, source);
		expect(reviewed.status).toBe(200);
		const preview = requirePreview(reviewed.body);
		expect(preview.native.slots).toEqual([
			{ reference: "instruction", enabled: true, role: "system", name: "Missing role", content: "default me" },
			{ reference: "instruction", enabled: true, role: "system", name: "Unsupported role", content: "default this" },
			{ reference: "instruction", enabled: true, role: "assistant", name: "Invalid position", content: "ordinary order" },
			{ reference: "instruction", enabled: true, role: "user", name: "First", content: "first content" },
			{ reference: "instruction", enabled: false, role: "user", name: "First", content: "first content" },
			{ reference: "instruction", enabled: false, role: "system", name: "Missing role", content: "default me" },
		]);
		expect(preview.diagnostics.map((item) => item.code)).toEqual([
			"duplicate-definition",
			"default-role",
			"default-role",
			"invalid-injection-position",
		]);
		expect(preview.diagnostics.find((item) => item.code === "default-role")?.message).toContain("system role");
		expect(preview.diagnostics.find((item) => item.code === "invalid-injection-position")?.message).toContain("ordinary recipe order");
		expect(preview.diagnostics.find((item) => item.code === "duplicate-definition")?.message).toContain("first was kept");

		const imported = await postImport(app, source);
		expect(imported.status).toBe(200);
		const applied = requireApplied(imported.body);
		expect(await exportPreset(app, applied.preset.id)).toEqual(preview.native);
		expect(applied.diagnostics).toEqual([
			{ code: "duplicate-definition", message: 'Prompt definition "duplicate" appeared more than once; later definitions were omitted and the first was kept.', identifier: "duplicate" },
			{ code: "default-role", message: 'Authored block "missing-role" had no supported role; the system role was used.', identifier: "missing-role" },
			{ code: "default-role", message: 'Authored block "unsupported-role" had no supported role; the system role was used.', identifier: "unsupported-role" },
			{ code: "invalid-injection-position", message: 'Injection position for authored block "invalid-position" was invalid; it was placed using ordinary recipe order.', identifier: "invalid-position" },
		]);
	});

	test("collapses repeated World Info occurrences to the first enabled occurrence", async () => {
		const app = createPromptPresetRoutes(database);
		const source: SillyTavernJsonValue = {
			prompts: [
				{ identifier: "worldInfoBefore", name: "Before", content: "", marker: true },
				{ identifier: "worldInfoAfter", name: "After", content: "", marker: true },
			],
			prompt_order: [{ character_id: 100001, order: [
				{ identifier: "worldInfoBefore", enabled: false },
				{ identifier: "worldInfoBefore", enabled: true },
				{ identifier: "worldInfoAfter", enabled: true },
			] }],
		};
		const reviewed = await postReview(app, source);
		expect(reviewed.status).toBe(200);
		const preview = requirePreview(reviewed.body);
		expect(preview.native.slots).toEqual([{ reference: "lore", enabled: true, role: "system" }]);
		expect(preview.diagnostics).toEqual([{ code: "collapsed-world-info", message: "Multiple World Info positions were collapsed into one Lore block." }]);
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
		const preview = requirePreview(reviewed.body);
		expect(preview.diagnostics.map((item) => item.code)).toEqual([
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
				{ identifier: "before", name: "Before", content: "{{user}} {{// hidden {{char}} }} {{//}}{{user}} {{char}}{{///}} \\{{char}} \\{{// hidden {{user}} {{char}} }} \\{{//}}{{user}} {{char}}{{///}}", role: "user", injection_position: 0 },
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
		const preview = requirePreview(reviewed.body);
		expect(preview.native.slots.map((slot) => slot.reference === "instruction" ? slot.content : slot.reference)).toEqual([
			"{{self}} {{// hidden {{char}} }} {{//}}{{user}} {{char}}{{///}} \\{{other}} \\{{// hidden {{user}} {{char}} }} \\{{//}}{{user}} {{char}}{{///}}",
			"history",
			"history",
			"one",
			"two",
		]);
		expect(preview.native.slots.map((slot) => slot.enabled)).toEqual([true, true, false, false, true]);
		expect(preview.diagnostics.some((item) => item.code === "depth-placement")).toBe(true);

		const noHistory: SillyTavernJsonValue = {
			prompts: [{ identifier: "depth", name: "Depth", content: "depth", role: "system", injection_position: 1 }],
			prompt_order: [{ character_id: 100001, order: [{ identifier: "depth", enabled: true }] }],
		};
		const noHistoryReview = await postReview(app, noHistory);
		expect(noHistoryReview.status).toBe(200);
		expect(requirePreview(noHistoryReview.body).diagnostics.some((item) => item.message.includes("no history slot"))).toBe(true);
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
		for (const { source, expectedContentInOrder } of samples) {
			const imported = await postImport(library, source);
			expect(imported.status).toBe(200);
			const applied = requireApplied(imported.body);
			expect(applied.selectedOrderId).toBe("100001");
			const authoredContent = applied.native.slots
				.filter((slot) => slot.reference === "instruction" && slot.enabled)
				.map((slot) => "content" in slot ? slot.content : "")
				.find((content) => content.trim() !== "");
			expect(authoredContent).toBeDefined();

			const latest = await conversations.handle(new Request(`http://localhost/api/conversations/${conversation.id}`));
			// ==[HUMAN APPROVED]== SAFETY: this GET response is the conversation route's declared snapshot.
			const latestBody = await latest.json() as ConversationRevision;
			const selected = await conversations.handle(new Request(`http://localhost/api/conversations/${conversation.id}/commands`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision: latestBody.revision, action: { type: "select-prompt-preset", promptPresetId: applied.preset.id } }),
			}));
			expect(selected.status).toBe(200);
			const afterSelection = await conversations.handle(new Request(`http://localhost/api/conversations/${conversation.id}`));
			// ==[HUMAN APPROVED]== SAFETY: this GET response is the conversation route's declared snapshot.
			const afterSelectionBody = await afterSelection.json() as ConversationRevision;
			captured = { messages: [] };
			const accepted = await conversations.handle(new Request(`http://localhost/api/conversations/${conversation.id}/generations`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision: afterSelectionBody.revision, content: "Set the scene." }),
			}));
			expect(accepted.status).toBe(200);
			// ==[HUMAN APPROVED]== SAFETY: this POST response is the conversation route's declared generation.
			const acceptedBody = await accepted.json() as AcceptedGeneration;
			const events = await conversations.handle(new Request(`http://localhost/api/conversations/${conversation.id}/generations/${acceptedBody.generationId}/events`));
			await events.text();
			const capturedContent = captured.messages.map((message) => message.content).join("\n");
			const firstPosition = capturedContent.indexOf(expectedContentInOrder[0]);
			const secondPosition = capturedContent.indexOf(expectedContentInOrder[1]);
			expect(firstPosition).toBeGreaterThanOrEqual(0);
			expect(secondPosition).toBeGreaterThan(firstPosition);
		}
	});

	test("preserves unlisted supported references as disabled trailing slots in source order through review, commit and native reimport", async () => {
		const app = createPromptPresetRoutes(database);
		const source: SillyTavernJsonValue = {
			prompts: [
				{ identifier: "main", name: "Main", content: "listed instruction", role: "system" },
				{ identifier: "personaDescription", name: "Writer", content: "writer identity", role: "user" },
				{ identifier: "charDescription", name: "Character", content: "model identity", role: "assistant" },
				{ identifier: "chatHistory", name: "History", content: "", marker: true },
				{ identifier: "scenario", name: "Scene", content: "scene", role: "system" },
				{ identifier: "unlisted", name: "Unlisted", content: "instruction", role: "assistant" },
				{ identifier: "charPersonality", name: "Personality", content: "personality", role: "system" },
				{ identifier: "worldInfoBefore", name: "World", content: "world", role: "system" },
			],
			prompt_order: [{ character_id: 100001, order: [{ identifier: "main", enabled: true }] }],
		};
		const reviewed = await postReview(app, source);
		expect(reviewed.status).toBe(200);
		const preview = requirePreview(reviewed.body);
		// The unlisted supported references become disabled trailing slots in
		// source definition order; unlisted authored text joins them, and the
		// unsupported placeholders are omitted with one diagnostic each.
		expect(preview.native.slots).toEqual([
			{ reference: "instruction", enabled: true, role: "system", name: "Main", content: "listed instruction" },
			{ reference: "human-identity", enabled: false, role: "user" },
			{ reference: "model-identity", enabled: false, role: "assistant" },
			{ reference: "history", enabled: false },
			{ reference: "model-scenario", enabled: false, role: "system" },
			{ reference: "instruction", enabled: false, role: "assistant", name: "Unlisted", content: "instruction" },
		]);
		expect(preview.diagnostics.map((item) => item.code)).toEqual([
			"unsupported-placeholder",
			"collapsed-world-info",
		]);

		const imported = await postImport(app, source);
		expect(imported.status).toBe(200);
		const applied = requireApplied(imported.body);
		expect(applied.native.slots).toEqual(preview.native.slots);

		// The stored disabled slots survive native export and reimport as
		// references only — no resolved Participant content is embedded.
		const exported = await exportPreset(app, applied.preset.id);
		expect(exported).toEqual(applied.native);
		const reimported = await importNativePreset(app, exported);
		expect(reimported.status).toBe(200);
		// SAFETY: the applied native import response carries the new preset id.
		const reread = await exportPreset(app, (reimported.body as { preset: { id: number } }).preset.id);
		expect(reread).toEqual(exported);
	});

	test("translates active user and character macros after even backslash runs and keeps odd-run escapes", async () => {
		const app = createPromptPresetRoutes(database);
		const source: SillyTavernJsonValue = {
			prompts: [
				{
					identifier: "main",
					name: "Escapes",
					content: "\\\\{{user}} \\\\\\\\{{char}} \\\\\\{{user}} \\{{char}} {{user}} {{char}}",
					role: "system",
				},
			],
			prompt_order: [{ character_id: 100001, order: [{ identifier: "main", enabled: true }] }],
		};
		const reviewed = await postReview(app, source);
		expect(reviewed.status).toBe(200);
		const preview = requirePreview(reviewed.body);
		// A backslash pair is an escaped backslash that leaves the following
		// macro active; an odd run escapes the macro, which stays verbatim.
		expect(preview.native.slots).toEqual([
			{
				reference: "instruction",
				enabled: true,
				role: "system",
				name: "Escapes",
				content: "\\\\{{self}} \\\\\\\\{{other}} \\\\\\{{self}} \\{{other}} {{self}} {{other}}",
			},
		]);

		const imported = await postImport(app, source);
		expect(imported.status).toBe(200);
		expect(requireApplied(imported.body).native.slots).toEqual(preview.native.slots);
	});

	test("translates nested participant macros inside conditional scopes", async () => {
		const app = createPromptPresetRoutes(database);
		const source: SillyTavernJsonValue = {
			prompts: [{
				identifier: "main",
				name: "Nested participants",
				content: "{{if::true}}{{user}} begins; {{char}} follows.{{/if}}",
				role: "system",
			}],
			prompt_order: [{ character_id: 100001, order: [{ identifier: "main", enabled: true }] }],
		};
		const reviewed = await postReview(app, source);
		expect(reviewed.status).toBe(200);
		expect(requirePreview(reviewed.body).native.slots[0]).toMatchObject({
			content: "{{if::true}}{{self}} begins; {{other}} follows.{{/if}}",
		});
	});

	test("the reproduced two-backslash source reaches the captured Generation request with the escaped backslash and the translated name", async () => {
		const library = createPromptPresetRoutes(database);
		const source: SillyTavernJsonValue = {
			prompts: [{ identifier: "main", name: "Two slash", content: "\\\\{{user}} precedes {{self}}.", role: "system" }],
			prompt_order: [{ character_id: 100001, order: [{ identifier: "main", enabled: true }] }],
		};
		const imported = await postImport(library, source);
		expect(imported.status).toBe(200);
		const applied = requireApplied(imported.body);

		const conversation = createChat(database);
		withProfile(database);
		const conversations = createConversationRoutes(database);
		const revision = (await readConversation(conversations, conversation.id)).revision;
		await selectPreset(conversations, conversation.id, revision, applied.preset.id);
		const selectedRevision = (await readConversation(conversations, conversation.id)).revision;

		let captured: { messages: { role: string; content: string }[] } | undefined;
		const generating = createConversationRoutes(database, {
			masterKey: key,
			fetch: captureModelFetch((request) => { captured = request; }),
		});
		const generationId = await startGeneration(generating, conversation.id, selectedRevision);
		await completeGeneration(generating, conversation.id, generationId);
		while (captured === undefined) await new Promise((resolve) => setTimeout(resolve, 0));

		// The adjacent backslash pair remains authored text, then the active
		// `{{self}}` names the human-controlled Participant.
		expect(captured?.messages).toContainEqual({
			role: "system",
			content: "\\\\Writer precedes Writer.",
		});
	});

	test("enabling a retained disabled reference reaches the Conversation's own Participant content in the captured request", async () => {
		const library = createPromptPresetRoutes(database);
		const source: SillyTavernJsonValue = {
			prompts: [
				{ identifier: "main", name: "Main", content: "main", role: "system" },
				{ identifier: "charDescription", name: "Character", content: "model identity", role: "assistant" },
				{ identifier: "personaDescription", name: "Writer", content: "writer identity", role: "user" },
				{ identifier: "chatHistory", name: "History", content: "", marker: true },
			],
			prompt_order: [{ character_id: 100001, order: [{ identifier: "main", enabled: true }] }],
		};
		const imported = await postImport(library, source);
		expect(imported.status).toBe(200);
		const applied = requireApplied(imported.body);
		expect(applied.native.slots.map((slot) => "name" in slot ? slot.name : slot.reference)).toEqual([
			"Main",
			"model-identity",
			"human-identity",
			"history",
		]);
		expect(applied.native.slots.map((slot) => slot.enabled)).toEqual([true, false, false, false]);

		const conversation = createChat(database);
		withProfile(database);
		const conversations = createConversationRoutes(database);
		const revision = (await readConversation(conversations, conversation.id)).revision;
		await selectPreset(conversations, conversation.id, revision, applied.preset.id);

		// The retained model Identity reference is enabled through the existing
		// block toggle; the recipe still stores a reference, never content.
		const resolved = await readPreset(conversations, conversation.id);
		const retained = resolved.slots.find((slot) => slot.reference === "model-identity");
		if (retained === undefined) throw new Error("The retained model Identity slot is missing.");
		await readOperation(toggleBlock(database, applied.preset.id, retained.id, true));
		const afterToggle = await readPreset(conversations, conversation.id);
		expect(afterToggle.slots.find((slot) => slot.id === retained.id)).toMatchObject({
			reference: "model-identity",
			enabled: true,
			sourceName: "Maren",
			content: "I am {{self}}.",
		});
		const selectedRevision = (await readConversation(conversations, conversation.id)).revision;

		let captured: { messages: { role: string; content: string }[] } | undefined;
		const generating = createConversationRoutes(database, {
			masterKey: key,
			fetch: captureModelFetch((request) => { captured = request; }),
		});
		const generationId = await startGeneration(generating, conversation.id, selectedRevision);
		await completeGeneration(generating, conversation.id, generationId);
		while (captured === undefined) await new Promise((resolve) => setTimeout(resolve, 0));

		// This Conversation's own model Participant content reaches the request
		// with the reference's default outgoing role; the disabled history and
		// human Identity slots contribute nothing.
		expect(captured?.messages).toEqual([
			{ role: "system", content: "main" },
			{ role: "assistant", content: "I am Maren." },
		]);
	});

	test("preserves inline and scoped comments, multiline bodies, nested delimiters and escaped comments in stored text", async () => {
		const app = createPromptPresetRoutes(database);
		const source: SillyTavernJsonValue = {
			prompts: [
				{
					identifier: "main",
					name: "Comments",
					content: "Start {{// hidden {{user}} {{char}} }} inline {{//}}{{user}} {{char}}{{///}} scoped {{// line1\nline2 {{user}} }} multi \\{{// kept {{user}} }} \\{{//}} kept {{char}} {{///}} end",
					role: "system",
				},
			],
			prompt_order: [{ character_id: 100001, order: [{ identifier: "main", enabled: true }] }],
		};
		const reviewed = await postReview(app, source);
		expect(reviewed.status).toBe(200);
		const preview = requirePreview(reviewed.body);
		const stored = preview.native.slots[0];
		// The comments are preserved verbatim, including their bodies and the
		// escaping backslashes: no active macro translation happens inside them.
		expect(stored).toEqual({
			reference: "instruction",
			enabled: true,
			role: "system",
			name: "Comments",
			content: "Start {{// hidden {{user}} {{char}} }} inline {{//}}{{user}} {{char}}{{///}} scoped {{// line1\nline2 {{user}} }} multi \\{{// kept {{user}} }} \\{{//}} kept {{char}} {{///}} end",
		});

		const conversation = createChat(database);
		withProfile(database);
		const imported = await postImport(app, source);
		expect(imported.status).toBe(200);
		const applied = requireApplied(imported.body);
		const conversations = createConversationRoutes(database);
		const revision = (await readConversation(conversations, conversation.id)).revision;
		await selectPreset(conversations, conversation.id, revision, applied.preset.id);
		const selectedRevision = (await readConversation(conversations, conversation.id)).revision;

		let captured: { messages: { role: string; content: string }[] } | undefined;
		let inspection: {
			promptPlan: { warnings: { block: string; macro: string }[] };
		} | undefined;
		const generating = createConversationRoutes(database, {
			masterKey: key,
			fetch: captureModelFetch((request) => { captured = request; }),
		});
		const generationId = await startGeneration(generating, conversation.id, selectedRevision);
		const inspected = await generating.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${generationId}/inspection`,
		));
		// SAFETY: the route's response schema is the active inspection payload.
		inspection = await inspected.json() as typeof inspection;
		await completeGeneration(generating, conversation.id, generationId);
		while (captured === undefined) await new Promise((resolve) => setTimeout(resolve, 0));

		// Compilation drops the active comments whole without evaluating or
		// warning about their contents; the escaped comments stay literal.
		expect(captured?.messages).toEqual([{
			role: "system",
			content: "Start  inline  scoped  multi \\{{// kept {{user}} }} \\{{//}} kept {{char}} {{///}} end",
		}]);
		expect(inspection?.promptPlan.warnings).toEqual([]);
	});

	test("expands supported macros and preserves malformed delimiters", async () => {
		const app = createPromptPresetRoutes(database);
		const source: SillyTavernJsonValue = {
			prompts: [
				{ identifier: "main", name: "Supported macros", content: "{{time}} stays and {{user stays open", role: "system" },
			],
			prompt_order: [{ character_id: 100001, order: [{ identifier: "main", enabled: true }] }],
		};
		const reviewed = await postReview(app, source);
		expect(reviewed.status).toBe(200);
		const preview = requirePreview(reviewed.body);
		// Import translation only rewrites user/character names. The supported
		// native time macro stays authored text until Generation compilation.
		expect(preview.native.slots[0]).toEqual({
			reference: "instruction",
			enabled: true,
			role: "system",
			name: "Supported macros",
			content: "{{time}} stays and {{user stays open",
		});

		const conversation = createChat(database);
		withProfile(database);
		const imported = await postImport(app, source);
		expect(imported.status).toBe(200);
		const applied = requireApplied(imported.body);
		const conversations = createConversationRoutes(database);
		const revision = (await readConversation(conversations, conversation.id)).revision;
		await selectPreset(conversations, conversation.id, revision, applied.preset.id);
		const selectedRevision = (await readConversation(conversations, conversation.id)).revision;

		let captured: { messages: { role: string; content: string }[] } | undefined;
		const generating = createConversationRoutes(database, {
			masterKey: key,
			fetch: captureModelFetch((request) => { captured = request; }),
		});
		const generationId = await startGeneration(generating, conversation.id, selectedRevision);
		const inspected = await generating.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${generationId}/inspection`,
		));
		// SAFETY: the route's response schema is the active inspection payload.
		const inspection = await inspected.json() as {
			promptPlan: { warnings: { block: string; macro: string }[] };
		};
		await completeGeneration(generating, conversation.id, generationId);
		while (captured === undefined) await new Promise((resolve) => setTimeout(resolve, 0));

		// The supported time macro expands; the malformed delimiter stays raw
		// text without a warning, and Generation is available throughout.
		expect(captured?.messages).toHaveLength(1);
		expect(captured?.messages[0]?.content).toMatch(/^\d{1,2}:\d{2} [AP]M stays and \{\{user stays open$/);
		expect(inspection.promptPlan.warnings).toEqual([]);
	});
});
