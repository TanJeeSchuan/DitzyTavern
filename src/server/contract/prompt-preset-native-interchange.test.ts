import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createConnectionSettingsModule } from "../connection-settings";
import { createConversationModule } from "../conversation";
import { createConversationRoutes } from "./conversation";
import { createPromptPresetRoutes } from "./prompt-preset-routes";
import type { ModelFetch } from "../model-client";
import type {
	ConversationSummary,
} from "../../shared/contract/conversation-schema";
import type {
	ConversationPromptPreset,
	NativePromptPreset,
	PromptPresetCommand,
	PromptPresetListResponse,
	PromptPresetSummary,
} from "../../shared/contract/prompt-preset";

const key = new Uint8Array(32).fill(11);

const humanPrompt = {
	systemInstruction: "Human system text never reaches the plan.",
	identity: "I write as {{self}} opposite {{other}}.",
	scenario: "Human scenario never reaches the plan.",
	exampleDialogue: "Human examples never reach the plan.",
	postHistoryInstruction: "Human post-history never reaches the plan.",
};

const modelPrompt = {
	systemInstruction: "Answer briefly.",
	identity: "I am {{self}}.",
	scenario: "A quiet room.",
	exampleDialogue: "Writer: Hello\nMaren: Hello back",
	postHistoryInstruction: "Continue.",
};

const profile = {
	displayName: "DeepSeek",
	apiFormat: "chat-completions" as const,
	requestUrl: "http://127.0.0.1:43131/v1/",
	modelsUrl: "",
	modelBackend: "automatic" as const,
	adapter: "deepseek" as const,
	outputTokenRepresentation: "automatic" as const,
	timeoutMs: 120_000,
	pinnedModels: [],
};

interface CapturedRequest {
	messages: { role: string; content: string }[];
}

const createChat = (database: Database, name = "Preset Chat") =>
	createConversationModule(database).create({
		name,
		participants: [
			{ definition: { name: "Writer", prompt: humanPrompt, openings: [] } },
			{ definition: { name: "Maren", prompt: modelPrompt, openings: [] } },
		],
		control: { human: 0, model: 1 },
	});

// ==[HUMAN APPROVED]== Library and selection tests exercise the ordinary public routes
// against one isolated initialized database: the same seam the popup uses,
// with no test-only transport or persistence helpers.
const createRoutes = (database: Database) => ({
	library: createPromptPresetRoutes(database),
	conversations: createConversationRoutes(database),
});

const listPresets = async (
	app: ReturnType<typeof createPromptPresetRoutes>,
): Promise<PromptPresetSummary[]> => {
	const response = await app.handle(new Request("http://localhost/api/prompt-presets"));
	expect(response.status).toBe(200);
	// SAFETY: the route's response schema is the library list payload.
	const payload = await response.json() as PromptPresetListResponse;
	return payload.presets;
};

const exportPreset = async (
	app: ReturnType<typeof createPromptPresetRoutes>,
	presetId: number,
): Promise<NativePromptPreset> => {
	const response = await app.handle(
		new Request(`http://localhost/api/prompt-presets/${presetId}/export`),
	);
	expect(response.status).toBe(200);
	// SAFETY: the route's response schema is the native interchange payload.
	return await response.json() as NativePromptPreset;
};

type NativePromptPresetRequest = {
	name: string;
	slots: Array<{
		reference: string;
		enabled: boolean;
		role?: string | null;
		name?: string;
		content?: string;
	}>;
};

const importPreset = async (
	app: ReturnType<typeof createPromptPresetRoutes>,
	native: NativePromptPresetRequest,
): Promise<{ status: number; body: unknown }> => {
	const response = await app.handle(
		new Request("http://localhost/api/prompt-presets/import", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(native),
		}),
	);
	return { status: response.status, body: await response.json() };
};

const runPresetCommand = async (
	app: ReturnType<typeof createPromptPresetRoutes>,
	command: PromptPresetCommand,
): Promise<{ status: number; body: unknown }> => {
	const response = await app.handle(
		new Request("http://localhost/api/prompt-presets/commands", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(command),
		}),
	);
	// SAFETY: the route validates the discriminated command at this boundary.
	const body = await response.json();
	return { status: response.status, body };
};

const readSelectedPreset = async (
	app: ReturnType<typeof createConversationRoutes>,
	conversationId: number,
): Promise<ConversationPromptPreset | null> => {
	const response = await app.handle(
		new Request(`http://localhost/api/conversations/${conversationId}/prompt-preset`),
	);
	if (response.status === 404) return null;
	expect(response.status).toBe(200);
	// SAFETY: the route's response schema is the resolved preset payload.
	return await response.json() as ConversationPromptPreset;
};

const readConversation = async (
	app: ReturnType<typeof createConversationRoutes>,
	conversationId: number,
): Promise<ConversationSummary> => {
	const response = await app.handle(
		new Request(`http://localhost/api/conversations/${conversationId}`),
	);
	expect(response.status).toBe(200);
	// SAFETY: the route's response schema is the conversation summary payload.
	return await response.json() as ConversationSummary;
};

const selectPreset = async (
	app: ReturnType<typeof createConversationRoutes>,
	conversationId: number,
	expectedRevision: number,
	promptPresetId: number,
): Promise<{ status: number; body: unknown }> => {
	const response = await app.handle(
		new Request(`http://localhost/api/conversations/${conversationId}/commands`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				expectedRevision,
				action: { type: "select-prompt-preset", promptPresetId },
			}),
		}),
	);
	// SAFETY: the route validates the revisioned command shape at this boundary.
	const body = await response.json();
	return { status: response.status, body };
};

// ==[HUMAN APPROVED]== The controlled provider fake captures every Chat Completions
// request behind a barrier, so a test runs mid-attempt Conversation
// operations against a held provider stream before releasing it.
const gatedProvider = () => {
	const requests: CapturedRequest[] = [];
	const waiters: (() => void)[] = [];
	let open = false;
	const encoder = new TextEncoder();
	const stream = () => new Response(new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Done." }, finish_reason: null }] })}\n\n`));
			controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`));
			controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			controller.close();
		},
	}), { headers: { "content-type": "text/event-stream" } });
	return {
		requests,
		release: () => {
			open = true;
			for (const waiter of waiters.splice(0)) waiter();
		},
		fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
			// SAFETY: the controlled fake receives the AI SDK Chat Completions body.
			requests.push(JSON.parse(String(init?.body)) as CapturedRequest);
			if (!open) await new Promise<void>((resolve) => { waiters.push(resolve); });
			return stream();
		}) satisfies ModelFetch,
	};
};

const startGeneration = async (
	app: ReturnType<typeof createConversationRoutes>,
	conversationId: number,
	expectedRevision: number,
	gate: { requests: CapturedRequest[] },
	minimumRequests = 1,
): Promise<number> => {
	const response = await app.handle(
		new Request(`http://localhost/api/conversations/${conversationId}/generations`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ expectedRevision, content: "Set the scene." }),
		}),
	);
	expect(response.status).toBe(200);
	// SAFETY: this contract test controls the typed acceptance response.
	const accepted = await response.json() as { generationId: number };
	while (gate.requests.length < minimumRequests) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	return accepted.generationId;
};

const completeGeneration = async (
	app: ReturnType<typeof createConversationRoutes>,
	conversationId: number,
	generationId: number,
): Promise<void> => {
	// ==[HUMAN APPROVED]== The events subscription drains only once the runtime closes its
	// stream at the terminal commit, so awaiting the body is the deterministic
	// completion wait.
	const subscription = await app.handle(new Request(
		`http://localhost/api/conversations/${conversationId}/generations/${generationId}/events`,
	));
	await subscription.text();
};

describe("Native Prompt Preset interchange", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("round-trips authored text, comments, references, roles, order and disabled repeats", async () => {
		const routes = createRoutes(database);
		const native: NativePromptPreset = {
			name: "Default",
			slots: [
				{
					reference: "instruction",
					enabled: false,
					role: "assistant",
					name: "Keep raw comments",
					content: "Before {{// {{not-a-macro}} }}\nAfter {{self}}",
				},
				{ reference: "model-identity", enabled: true, role: "user" },
				{ reference: "model-identity", enabled: true, role: "assistant" },
				{ reference: "history", enabled: false },
			],
		};

		const imported = await importPreset(routes.library, native);
		expect(imported.status).toBe(200);
		expect(imported.body).toMatchObject({
			outcome: "applied",
			preset: { id: 2, name: "Default", isDefault: false },
		});
		const roundTrip = await exportPreset(routes.library, 2);
		expect(roundTrip).toEqual(native);

		// Export is a stored recipe projection: it has references only, never the
		// selected Chat's Participant names, resolved content or history entries.
		const conversation = createChat(database);
		await selectPreset(routes.conversations, conversation.id, conversation.revision, 2);
		const resolved = await readSelectedPreset(routes.conversations, conversation.id);
		expect(resolved?.slots.map((slot) => slot.reference)).toEqual([
			"instruction",
			"model-identity",
			"model-identity",
			"history",
		]);
		expect(roundTrip).not.toHaveProperty("id");
		expect(roundTrip).not.toHaveProperty("sourceName");
		expect(roundTrip).not.toHaveProperty("content", "I am Maren.");
		expect(resolved?.slots[1]).toMatchObject({ sourceName: "Maren", content: "I am {{self}}." });
	});

	test("imports as a new independent preset and invalid input leaves the library unchanged", async () => {
		const routes = createRoutes(database);
		const native: NativePromptPreset = {
			name: "Independent",
			slots: [{
				reference: "instruction",
				enabled: true,
				role: "system",
				name: "Original",
				content: "Original source",
			}],
		};
		const imported = await importPreset(routes.library, native);
		expect(imported.status).toBe(200);

		const invalid = await importPreset(routes.library, {
			...native,
			slots: [{
				reference: "instruction",
				enabled: true,
				role: "invalid",
				name: "Broken",
				content: "Should not persist",
			}],
		});
		expect(invalid.status).toBe(422);
		expect((await listPresets(routes.library)).map((preset) => preset.name)).toEqual([
			"Default",
			"Independent",
		]);

		const renamed = await runPresetCommand(routes.library, {
			type: "rename",
			presetId: 2,
			expectedRevision: 0,
			name: "Independent copy",
		});
		expect(renamed.status).toBe(200);
		expect((await exportPreset(routes.library, 1)).name).toBe("Default");
		expect((await exportPreset(routes.library, 2)).name).toBe("Independent copy");
	});

	test("an imported recipe drives the selected Conversation's resolved request", async () => {
		const routes = createRoutes(database);
		const conversation = createChat(database);
		createConnectionSettingsModule(database, { masterKey: key }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "preset-secret",
		});
		const imported = await importPreset(routes.library, {
			name: "Captured",
			slots: [
				{ reference: "model-system-instruction", enabled: true, role: "system" },
				{
					reference: "instruction",
					enabled: true,
					role: "assistant",
					name: "Voice",
					content: "Speak for {{self}} to {{other}}.",
				},
				{ reference: "history", enabled: true },
				{ reference: "model-post-history-instruction", enabled: true, role: "system" },
			],
		});
		expect(imported.status).toBe(200);
		await selectPreset(routes.conversations, conversation.id, conversation.revision, 2);

		const gate = gatedProvider();
		const app = createConversationRoutes(database, { masterKey: key, fetch: gate.fetch });
		const selected = await readConversation(app, conversation.id);
		const generationId = await startGeneration(app, conversation.id, selected.revision, gate);
		gate.release();
		await completeGeneration(app, conversation.id, generationId);
		expect(gate.requests[0]?.messages).toEqual([
			{ role: "system", content: "Answer briefly." },
			{ role: "assistant", content: "Speak for Writer to Maren." },
			{ role: "user", content: "Writer: Set the scene." },
			{ role: "system", content: "Continue." },
		]);
	});
});
