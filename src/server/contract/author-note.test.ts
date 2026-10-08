import { readConversationGenerationSettings } from "../conversation";
import { openObservedDatabase } from "../test-fixtures/conversation";
import { createLorebookRoutes } from "./lorebook-routes";
import { Value } from "@sinclair/typebox/value";
import { createConnectionSettingsModule } from "../connection-settings";
import { pngFixture } from "../image/image-fixtures";
import { uploadImage } from "../image";
import { formatImageReference } from "../../shared/image-reference";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createConversationRoutes } from "./conversation";
import { generationPreview, chatHistoryPage, type ConversationAction } from "../../shared/contract/conversation-schema";
import {
	createChat,
	readConversation,
	readPreset,
	toggleBlock,
	saveBlockRole,
	readOperation,
	withProfile,
	key,
	captureModelFetch,
	startGeneration,
	completeGeneration,
	gatedProvider,
	readInspection,
	moveBlock,
} from "./prompt-preset-test-fixtures";

let database: Database;
beforeEach(() => {
	database = openObservedDatabase();
});
afterEach(() => database.close());

const command = (app: ReturnType<typeof createConversationRoutes>, id: number, revision: number, action: ConversationAction) => app.handle(new Request(`http://localhost/api/conversations/${id}/commands`, {
	method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: revision, action }),
}));

const saveNote = (app: ReturnType<typeof createConversationRoutes>, id: number, revision: number, content: string) => command(app, id, revision, { type: "set-author-note", content });

test("Author Note saves exact text, rejects stale edits, and clears with an empty save", async () => {
	const chat = createChat(database);
	const app = createConversationRoutes(database);
	expect(await readConversation(app, chat.id)).toMatchObject({ authorNote: "" });
	const content = '  *Keep quiet* "{{self}}"\n';
	expect((await saveNote(app, chat.id, chat.revision, content)).status).toBe(200);
	expect(await readConversation(app, chat.id)).toMatchObject({ authorNote: content, revision: chat.revision + 1 });
	expect((await saveNote(app, chat.id, chat.revision, "stale")).status).toBe(409);
	expect((await saveNote(app, chat.id, chat.revision + 1, "")).status).toBe(200);
	expect(await readConversation(app, chat.id)).toMatchObject({ authorNote: "" });
});

const preview = async (app: ReturnType<typeof createConversationRoutes>, id: number) => {
	const response = await app.handle(new Request(`http://localhost/api/conversations/${id}/generations/preview`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "send", content: "Open the door." }),
	}));
	expect(response.status).toBe(200);
	return Value.Decode(generationPreview, await response.json());
};

test("Default recipe places the expanded Author Note immediately after history", async () => {
	const chat = createChat(database);
	const app = createConversationRoutes(database);
	expect((await saveNote(app, chat.id, chat.revision, "{{self}} guides {{other}}. {{// private }}")).status).toBe(200);
	const { promptPlan } = await preview(app, chat.id);
	const history = promptPlan.blocks.findIndex((block) => block.kind === "history");
	expect(promptPlan.blocks[history + 1]).toEqual({ kind: "author-note", role: "system", content: "Writer guides Maren. " });
});


test("Author Note is omitted when blank after expansion or disabled, and follows its slot role", async () => {
	const chat = createChat(database);
	const app = createConversationRoutes(database);
	const blank = await preview(app, chat.id);
	expect(blank.promptPlan.blocks.some((block) => block.kind === "author-note")).toBe(false);
	await saveNote(app, chat.id, chat.revision, " \n{{// hidden }}");
	const whitespace = await preview(app, chat.id);
	expect(whitespace.promptPlan.blocks.some((block) => block.kind === "author-note")).toBe(false);
	expect(whitespace.budget.tokenEstimate).toBe(blank.budget.tokenEstimate);
	await saveNote(app, chat.id, chat.revision + 1, "Keep the door shut.");
	const preset = await readPreset(app, chat.id);
	const slot = preset.slots.find((entry) => entry.reference === "author-note")!;
	await readOperation(saveBlockRole(database, preset.id, slot.id, "assistant"));
	expect((await preview(app, chat.id)).promptPlan.blocks.find((block) => block.kind === "author-note")).toEqual({ kind: "author-note", role: "model", content: "Keep the door shut." });
	await readOperation(toggleBlock(database, preset.id, slot.id, false));
	expect((await preview(app, chat.id)).promptPlan.blocks.some((block) => block.kind === "author-note")).toBe(false);
});

test("Author Note variable writes persist in Macro State after sending", async () => {
	const chat = createChat(database);
	withProfile(database);
	const app = createConversationRoutes(database, { masterKey: key, fetch: captureModelFetch(() => {}) });
	await saveNote(app, chat.id, chat.revision, "{{setvar::weather::rain}}{{getvar::weather}} for {{other}}");
	const planned = await preview(app, chat.id);
	expect(planned.pendingWrites).toContainEqual({ operation: "set", name: "weather", value: "rain" });
	expect(planned.promptPlan.blocks.find((block) => block.kind === "author-note")?.content).toBe("rain for Maren");
	const generationId = await startGeneration(app, chat.id, chat.revision + 1);
	await completeGeneration(app, chat.id, generationId);
	const response = await app.handle(new Request(`http://localhost/api/conversations/${chat.id}/macro-variables`));
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ variables: [{ name: "weather", value: "rain" }] });
});

test("editing during an Active Generation preserves its capture and reaches a later selected branch", async () => {
	const chat = createChat(database);
	withProfile(database);
	const gate = gatedProvider();
	const app = createConversationRoutes(database, { masterKey: key, fetch: gate.fetch });
	await saveNote(app, chat.id, chat.revision, "Old note");
	const id = await startGeneration(app, chat.id, chat.revision + 1, gate);
	const active = await readConversation(app, chat.id);
	expect((await saveNote(app, chat.id, active.revision, "Current note")).status).toBe(200);
	expect((await readInspection(app, chat.id, id)).promptPlan.blocks.find((block) => block.kind === "author-note")?.content).toBe("Old note");
	gate.release();
	await completeGeneration(app, chat.id, id);
	const historyResponse = await app.handle(new Request(`http://localhost/api/conversations/${chat.id}/history`));
	expect(historyResponse.status).toBe(200);
	const history = Value.Decode(chatHistoryPage, await historyResponse.json());
	const humanMessage = history.messages[0]!;
	const oldVariantId = humanMessage.variants[0]!.id;
	let current = await readConversation(app, chat.id);
	expect((await command(app, chat.id, current.revision, { type: "create-variant", messageId: humanMessage.id, content: "Another branch" })).status).toBe(200);
	current = await readConversation(app, chat.id);
	expect((await command(app, chat.id, current.revision, { type: "select-variant", messageId: humanMessage.id, variantId: oldVariantId })).status).toBe(200);
	expect((await preview(app, chat.id)).promptPlan.blocks.find((block) => block.kind === "author-note")?.content).toBe("Current note");
	expect(gate.requests[0]?.messages.some((message) => message.content === "Old note")).toBe(true);
	expect((await readInspection(app, chat.id, id)).promptPlan.blocks.find((block) => block.kind === "author-note")?.content).toBe("Old note");
});

test("oversized Author Note refuses sending instead of dropping the note", async () => {
	const chat = createChat(database);
	withProfile(database);
	const requests: unknown[] = [];
	const app = createConversationRoutes(database, { masterKey: key, fetch: captureModelFetch((request) => requests.push(request)) });
	const note = "Keep this standing guidance. ".repeat(30_000);
	await saveNote(app, chat.id, chat.revision, note);
	const planned = await preview(app, chat.id);
	expect(planned.budget.budgetFits).toBe(false);
	expect(planned.promptPlan.blocks.find((block) => block.kind === "author-note")?.content).toBe(note);
	const response = await app.handle(new Request(`http://localhost/api/conversations/${chat.id}/generations`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "send",  expectedRevision: chat.revision + 1, content: "Open the door." }),
	}));
	expect(response.status).toBe(422);
	expect(requests).toEqual([]);
});

test("Author Note Image References send their anchor and pixels, or only the anchor for a Text-only Model", async () => {
	const chat = createChat(database);
	withProfile(database);
	const bytes = pngFixture({ width: 100, height: 100 });
	const image = await uploadImage(database, bytes);
	let captured: unknown;
	const app = createConversationRoutes(database, { masterKey: key, fetch: captureModelFetch((request) => { captured = request; }) });
	await saveNote(app, chat.id, chat.revision, `Study ${formatImageReference("map", image.hash)}`);
	const planned = await preview(app, chat.id);
	expect(planned.promptPlan.images).toMatchObject([{ name: "map", disposition: "send" }]);
	const id = await startGeneration(app, chat.id, chat.revision + 1);
	await completeGeneration(app, chat.id, id);
	expect(captured).toMatchObject({ messages: expect.arrayContaining([{ role: "user", content: [
		{ type: "text", text: "[Image: map]" },
		{ type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}` } },
	] }]) });
	const connections = createConnectionSettingsModule(database, { masterKey: key });
	const settings = connections.get();
	const profile = settings.profiles[0]!;
	const generationSettings = readConversationGenerationSettings(database, chat.id)!;
	connections.setTextOnlyModel({ profileId: profile.id, modelId: generationSettings.modelId, textOnly: true });
	const current = await readConversation(app, chat.id);
	const textOnly = await preview(app, chat.id);
	expect(textOnly.promptPlan.images).toMatchObject([{ name: "map", disposition: "text-only" }]);
	const next = await startGeneration(app, chat.id, current.revision);
	await completeGeneration(app, chat.id, next);
	expect(JSON.stringify(captured)).toContain("Study [Image: map]");
	expect(JSON.stringify(captured)).not.toContain("image_url");
	expect(JSON.stringify(captured)).not.toContain(image.hash);
});

test("a keyword only in the Author Note activates no Lore Entry", async () => {
	const chat = createChat(database);
	const lore = createLorebookRoutes(database);
	const imported = await lore.handle(new Request("http://localhost/api/lorebooks/import", {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Secrets", description: "", entries: [{
			title: "Dragon", content: "A dragon sleeps here.", keywords: ["dragon"], semanticTriggers: [], matchOperator: "or", always: false,
			requireAny: [], requireAll: [], excludeAny: [], excludeAll: [], caseSensitive: false, wholeWord: true, keywordMode: "literal", regexFlags: "", priority: 0, enabled: true,
		}] }),
	}));
	expect(imported.status).toBe(200);
	const attachmentResponse = await lore.handle(new Request(`http://localhost/api/lorebooks/attachments?conversationId=${chat.id}`));
	const { revision } = await attachmentResponse.json();
	const attached = await lore.handle(new Request("http://localhost/api/lorebooks/attachments/commands", {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "attach-chat", conversationId: chat.id, bookId: 1, expectedRevision: revision }),
	}));
	expect(attached.status).toBe(200);
	const app = createConversationRoutes(database);
	const current = await readConversation(app, chat.id);
	await saveNote(app, chat.id, current.revision, "Include a dragon.");
	const planned = await preview(app, chat.id);
	expect(planned.promptPlan.blocks.find((block) => block.kind === "author-note")?.content).toBe("Include a dragon.");
	expect(planned.promptPlan.blocks.some((block) => block.kind === "lore")).toBe(false);
	expect((await command(app, chat.id, current.revision + 1, { type: "create-message", timestamp: "2026-10-07T00:00:00.000Z", variantContents: ["A dragon opens the door."], authorParticipantId: current.control.humanParticipantId! })).status).toBe(200);
	const story = await preview(app, chat.id);
	expect(story.promptPlan.blocks.find((block) => block.kind === "lore")?.content).toBe("A dragon sleeps here.");
});

test("Author Note slot is movable", async () => {
	const chat = createChat(database);
	const app = createConversationRoutes(database);
	await saveNote(app, chat.id, chat.revision, "Standing guidance");
	const preset = await readPreset(app, chat.id);
	const slot = preset.slots.find((entry) => entry.reference === "author-note")!;
	await readOperation(moveBlock(database, preset.id, slot.id, 1));
	expect((await preview(app, chat.id)).promptPlan.blocks[0]).toEqual({ kind: "author-note", role: "system", content: "Standing guidance" });
});
