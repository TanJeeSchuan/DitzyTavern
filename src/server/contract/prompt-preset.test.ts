import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInitializedDatabase } from "../database/database";
import { createConnectionSettingsModule } from "../connection-settings";
import { createConversationModule } from "../conversation";
import { createConversationRoutes } from "./conversation";
import type { ConversationPromptPreset } from "../../shared/contract/prompt-preset";

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
	requestUrl: "http://127.0.0.1:43129/v1/",
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

const createChat = (database: Database) =>
	createConversationModule(database).create({
		name: "Preset Chat",
		participants: [
			{ definition: { name: "Writer", prompt: humanPrompt, openings: [] } },
			{ definition: { name: "Maren", prompt: modelPrompt, openings: [] } },
		],
		control: { human: 0, model: 1 },
	});

const readPreset = async (
	app: ReturnType<typeof createConversationRoutes>,
	conversationId: number,
): Promise<ConversationPromptPreset> => {
	const response = await app.handle(
		new Request(`http://localhost/api/conversations/${conversationId}/prompt-preset`),
	);
	expect(response.status).toBe(200);
	// SAFETY: the route's response schema is the resolved preset payload.
	return await response.json() as ConversationPromptPreset;
};

describe("Prompt Preset transport", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("resolves the Default recipe against this Chat's own Participants", async () => {
		const conversation = createChat(database);
		const app = createConversationRoutes(database);

		const preset = await readPreset(app, conversation.id);

		expect(preset.name).toBe("Default");
		expect(preset.slots.map((slot) => slot.reference)).toEqual([
			"model-system-instruction",
			"human-identity",
			"model-identity",
			"model-scenario",
			"model-example-dialogue",
			"history",
			"model-post-history-instruction",
		]);
		expect(preset.slots.every((slot) => slot.enabled)).toBe(true);
		// The recipe stores references, so each slot reads the Conversation-local
		// Definition of the Participant in that Control seat — including the
		// authored macro text, which the preset never stores rendered.
		expect(preset.slots).toEqual(expect.arrayContaining([
			{
				reference: "human-identity",
				enabled: true,
				sourceName: "Writer",
				content: "I write as {{self}} opposite {{other}}.",
			},
			{
				reference: "model-identity",
				enabled: true,
				sourceName: "Maren",
				content: "I am {{self}}.",
			},
			{
				reference: "model-system-instruction",
				enabled: true,
				sourceName: "Maren",
				content: "Answer briefly.",
			},
			{ reference: "history", enabled: true, entryCount: 0 },
		]));
	});

	test("returns not-found for a Conversation that does not exist", async () => {
		const app = createConversationRoutes(database);
		const response = await app.handle(
			new Request("http://localhost/api/conversations/424242/prompt-preset"),
		);
		expect(response.status).toBe(404);
	});

	test("assembles the outgoing request through the stored recipe and agrees with active inspection", async () => {
		const conversation = createChat(database);
		createConnectionSettingsModule(database, { masterKey: key }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "preset-secret",
		});
		const encoder = new TextEncoder();
		let captured: CapturedRequest | undefined;
		let release = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const app = createConversationRoutes(database, {
			masterKey: key,
			fetch: async (_input, init) => {
				// SAFETY: the controlled fake receives the AI SDK Chat Completions body.
				captured = JSON.parse(String(init?.body)) as CapturedRequest;
				return new Response(new ReadableStream({
					async start(controller) {
						await gate;
						controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Done." }, finish_reason: null }] })}\n\n`));
						controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`));
						controller.enqueue(encoder.encode("data: [DONE]\n\n"));
						controller.close();
					},
				}), { headers: { "content-type": "text/event-stream" } });
			},
		});

		const started = await app.handle(
			new Request(`http://localhost/api/conversations/${conversation.id}/generations`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision: conversation.revision, content: "Set the scene." }),
			}),
		);
		expect(started.status).toBe(200);
		// SAFETY: this contract test controls the typed acceptance response.
		const accepted = await started.json() as { generationId: number };
		while (captured === undefined) await new Promise((resolve) => setTimeout(resolve, 0));

		const inspected = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${accepted.generationId}/inspection`,
		));
		expect(inspected.status).toBe(200);
		// SAFETY: the route's response schema is the active inspection payload.
		const inspection = await inspected.json() as {
			promptPlan: { blocks: { kind: string; content: string }[] };
		};

		// The Default recipe reproduces the established request: system text,
		// both Identity blocks under their roles, Scenario, Example Dialogue,
		// the selected history, then the Post-History Instruction.
		expect(captured?.messages).toEqual([
			{ role: "system", content: "Answer briefly." },
			{ role: "user", content: "I write as Writer opposite Maren." },
			{ role: "assistant", content: "I am Maren." },
			{ role: "system", content: "A quiet room." },
			{ role: "user", content: "Writer: Hello\nMaren: Hello back" },
			{ role: "user", content: "Writer: Set the scene." },
			{ role: "system", content: "Continue." },
		]);
		// The Active Generation consumes the Prompt Plan captured when it was
		// prepared, so inspection and the transmitted request describe the same
		// assembly rather than two independent compilations.
		expect(inspection.promptPlan.blocks.map((block) => block.kind)).toEqual([
			"system-instruction",
			"identity",
			"identity",
			"scenario",
			"example-dialogue",
			"history",
			"post-history-instruction",
		]);
		expect(inspection.promptPlan.blocks.map((block) => block.content)).toEqual([
			"Answer briefly.",
			"I write as Writer opposite Maren.",
			"I am Maren.",
			"A quiet room.",
			"Writer: Hello\nMaren: Hello back",
			"Set the scene.",
			"Continue.",
		]);

		release();
		await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${accepted.generationId}/events`,
		));
	});

	test("assembles through stored recipe edits rather than a fixed order", async () => {
		const conversation = createChat(database);
		createConnectionSettingsModule(database, { masterKey: key }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "preset-secret",
		});
		// A stored edit, standing in for the preset editor that later tickets
		// add: the Scenario slot is disabled and the Post-History Instruction
		// moves ahead of the history slot.
		database.exec(
			"UPDATE prompt_preset_block SET enabled = 0 WHERE reference = 'model-scenario'",
		);
		database.exec(
			"UPDATE prompt_preset_block SET position = 0 WHERE reference = 'model-post-history-instruction'",
		);
		let captured: CapturedRequest | undefined;
		const encoder = new TextEncoder();
		const app = createConversationRoutes(database, {
			masterKey: key,
			fetch: async (_input, init) => {
				// SAFETY: the controlled fake receives the AI SDK Chat Completions body.
				captured = JSON.parse(String(init?.body)) as CapturedRequest;
				return new Response(new ReadableStream({
					start(controller) {
						controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Done." }, finish_reason: null }] })}\n\n`));
						controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`));
						controller.enqueue(encoder.encode("data: [DONE]\n\n"));
						controller.close();
					},
				}), { headers: { "content-type": "text/event-stream" } });
			},
		});

		const started = await app.handle(
			new Request(`http://localhost/api/conversations/${conversation.id}/generations`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision: conversation.revision, content: "Set the scene." }),
			}),
		);
		expect(started.status).toBe(200);
		// SAFETY: this contract test controls the typed acceptance response.
		const accepted = await started.json() as { generationId: number };
		await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${accepted.generationId}/events`,
		));
		while (captured === undefined) await new Promise((resolve) => setTimeout(resolve, 0));

		expect(captured.messages).toEqual([
			{ role: "system", content: "Continue." },
			{ role: "system", content: "Answer briefly." },
			{ role: "user", content: "I write as Writer opposite Maren." },
			{ role: "assistant", content: "I am Maren." },
			{ role: "user", content: "Writer: Hello\nMaren: Hello back" },
			{ role: "user", content: "Writer: Set the scene." },
		]);
		const preset = await readPreset(app, conversation.id);
		expect(preset.slots.map((slot) => slot.reference)).toEqual([
			"model-post-history-instruction",
			"model-system-instruction",
			"human-identity",
			"model-identity",
			"model-scenario",
			"model-example-dialogue",
			"history",
		]);
		expect(
			preset.slots.find((slot) => slot.reference === "model-scenario")?.enabled,
		).toBe(false);
	});
});

describe("Prompt Preset durability", () => {
	let directory: string;

	beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "ditzy-preset-")); });
	afterEach(async () => {
		// ==[HUMAN APPROVED]== Bun may release the final SQLite WAL handle asynchronously on Windows.
		for (let attempt = 0; attempt < 20; attempt += 1) {
			try {
				rmSync(directory, { recursive: true, force: true });
				return;
			} catch {
				await Bun.sleep(100);
			}
		}
		rmSync(directory, { recursive: true, force: true });
	});

	test("keeps the stored Default recipe and Chat selection across restarts", async () => {
		const path = join(directory, "preset.sqlite");
		const first = openInitializedDatabase({ path });
		const conversation = createChat(first);
		first.exec("UPDATE prompt_preset SET name = 'Default (edited)' WHERE is_default = 1");
		first.exec("UPDATE prompt_preset_block SET enabled = 0 WHERE reference = 'model-example-dialogue'");
		first.close();

		const second = openInitializedDatabase({ path });
		try {
			const preset = await readPreset(createConversationRoutes(second), conversation.id);
			expect(preset.name).toBe("Default (edited)");
			expect(
				preset.slots.find((slot) => slot.reference === "model-example-dialogue")?.enabled,
			).toBe(false);
			expect(second.query("SELECT COUNT(*) AS total FROM prompt_preset").get())
				.toEqual({ total: 1 });
		} finally {
			second.close();
		}
	});
});
