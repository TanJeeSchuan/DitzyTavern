import { createPaintingRoutes } from "../contract/painting";
import { formatImageReference } from "../../shared/image-reference";
import { pngFixture } from "../image/image-fixtures";
import { uploadImage } from "../image";
import { expect, test, setSystemTime } from "bun:test";
import { openObservedDatabase, requireSnapshot, createConversationWithHistory } from "../test-fixtures/conversation";
import { humanPrompt, modelPrompt, createChat, conversationApp, withProfile, captureModelFetch, key, type CapturedRequest } from "../contract/prompt-preset-test-fixtures";
import { executeConversationCommand } from "../conversation";
import { macroWritesToData } from "../prompt-macros";
import { importNativePromptPreset } from "../prompt-preset";
import { createPaintingModule } from ".";
import { writeBrief } from "./brief";

test("a Brief uses its Paint Preset, the last N selected Messages ending at the target, matching Lore and a literal final Ask without storing output", async () => {
	const database = openObservedDatabase();
	setSystemTime(new Date("2026-06-15T02:00:00Z"));
	try {
		const chat = createChat(database);
		withProfile(database);
		for (const [index, content] of ["Outside the window", "River lantern", null, "At the bridge", "Later scene"].entries()) {
			const message = database.query<{ id: number }, [number, number, number, string]>("INSERT INTO messages (conversation_id, position, timestamp, author_participant_id, author_name) VALUES (?, ?, '', ?, ?) RETURNING id")
				.get(chat.id, index + 1, chat.control.modelParticipantId!, "Maren")!;
			if (content !== null) database.query("INSERT INTO message_variant (message_id, position, content, timestamp, selected) VALUES (?, 1, ?, '', 1)").run(message.id, content);
		}
		const snapshot = requireSnapshot(database, chat.id);
		const preset = importNativePromptPreset(database, { name: "Paint only", slots: [
			{ reference: "lore", enabled: true, role: "system" },
			{ reference: "history", enabled: true },
			{ reference: "box:author-note", enabled: true, role: "system", content: "Box must not run." },
			{ reference: "brief-instruction", enabled: true, role: "assistant", content: "Paint {{self}} in charcoal on {{date}}. {{setvar::temporary::changed}}" },
			{ reference: "instruction", enabled: true, role: "system", name: "End", content: "Last preset block." },
		] });
		executeConversationCommand(database, { conversationId: chat.id, expectedRevision: chat.revision, action: { type: "set-box-setup", box: "author-note", setup: "This nonempty Box note must not reach the Brief." } });
		const paintings = createPaintingModule(database);
		paintings.command(chat.id, { type: "select-paint-preset", paintPresetId: preset.id });
		paintings.command(chat.id, { type: "set-brief-message-count", briefMessageCount: 2 });
		database.exec(`INSERT INTO lorebook (id, name) VALUES (1, 'River');
			INSERT INTO lorebook_entry (lorebook_id, position, title, content, keywords_json) VALUES (1, 1, 'Lantern', 'The lantern is green.', '["lantern"]'), (1, 2, 'Future', 'Wrong future Lore.', '["Later"]');`);
		database.query("INSERT INTO conversation_lorebook_attachment (conversation_id, lorebook_id) VALUES (?, 1)").run(chat.id);
		const before = requireSnapshot(database, chat.id);
		const rows = database.query("SELECT * FROM conversation_data").all();
		const variantRows = database.query("SELECT * FROM message_variant_data").all();
		const requests: CapturedRequest[] = [];
		const events = await Array.fromAsync(writeBrief(database, chat.id, { variantId: snapshot.messages[3]!.variants[0]!.id, ask: "Focus on {{self}} at the bridge.", locale: "fr-FR", timeZone: "Pacific/Honolulu" },
			{ masterKey: key, fetch: captureModelFetch((request) => requests.push(request)) }, new AbortController().signal));
		expect(requests).toHaveLength(1);
		const messages = requests[0]!.messages;
		expect(messages).toEqual([
			{ role: "system", content: "The lantern is green." },
			{ role: "assistant", content: "River lantern" },
			{ role: "assistant", content: "At the bridge" },
			{ role: "assistant", content: "Paint Writer in charcoal on 14 juin 2026. " },
			{ role: "system", content: "Last preset block." },
			{ role: "user", content: "Focus on {{self}} at the bridge." },
		]);
		expect(events.some((event) => event.type === "content")).toBe(true);
		expect(requireSnapshot(database, chat.id)).toEqual(before);
		expect(database.query("SELECT * FROM conversation_data").all()).toEqual(rows);
		expect(database.query("SELECT * FROM message_variant_data").all()).toEqual(variantRows);
	} finally { setSystemTime(); database.close(); }
});

test("an empty Ask names the scene, and Image References in an Ask reach the model without expanding macros", async () => {
	const database = openObservedDatabase();
	try {
		const chat = createConversationWithHistory(database, { name: "Scene", participants: [
			{ definition: { name: "Writer", prompt: humanPrompt, sendAppearanceImages: true, openings: [] } },
			{ definition: { name: "Maren", prompt: modelPrompt, sendAppearanceImages: true, openings: ["First scene"] } },
		], control: { human: 0, model: 1 } });
		withProfile(database);
		const requests: CapturedRequest[] = [];
		const routes = createPaintingRoutes(database, { masterKey: key, fetch: captureModelFetch((request) => requests.push(request)) });
		const write = async (ask: string) => {
			const response = await routes.handle(new Request(`http://localhost/api/conversations/${chat.id}/brief`, {
				method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ variantId: chat.messages[0]!.variants[0]!.id, ask }),
			}));
			expect(response.status).toBe(200);
			const stream = await response.text();
			expect(stream).toContain('"type":"content"');
			expect(stream).toContain('"type":"finished"');
		};
		await write("");
		expect(requests[0]!.messages).toContainEqual({ role: "user", content: "Write a short description of the scene for an image model. Describe the visible characters, setting, composition and lighting. Follow the writer's Ask. Return only the Brief." });
		expect(requests[0]!.messages.at(-1)).toEqual({ role: "user", content: "Describe the scene in the last Message above." });
		const image = await uploadImage(database, pngFixture());
		await write(`Paint {{self}} beside ${formatImageReference("Lantern", image.hash)}`);
		const sent = JSON.stringify(requests[1]!.messages.at(-1));
		expect(sent).toContain("Paint {{self}} beside [Image: Lantern]");
		expect(sent).toContain("image_url");
		expect(sent).not.toContain(image.hash);
	} finally { database.close(); }
});

test("a Brief request rejects unavailable Chats and invalid targets before streaming", async () => {
	const database = openObservedDatabase();
	try {
		const chat = createChat(database);
		const routes = createPaintingRoutes(database);
		const write = (id: number) => routes.handle(new Request(`http://localhost/api/conversations/${id}/brief`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ variantId: -1, ask: "Describe this." }),
		}));
		expect((await write(-1)).status).toBe(404);
		const invalid = await write(chat.id);
		expect(invalid.status).toBe(422);
		expect(await invalid.json()).toEqual({ outcome: "invalid", reason: "This reply was deleted; reopen Paint" });
		expect(() => createPaintingModule(database).command(chat.id, { type: "paint", ask: "", variantId: -1, brief: "A scene", aspectRatio: "1:1" })).toThrow("This reply was deleted; reopen Paint");
	} finally { database.close(); }
});

test("the ordinary preset editor reads a Paint Preset without changing the story selection", async () => {
	const database = openObservedDatabase();
	try {
		const chat = createChat(database);
		const preset = importNativePromptPreset(database, { name: "Charcoal", slots: [
			{ reference: "brief-instruction", enabled: true, role: "user", content: "Use charcoal." },
			{ reference: "model-identity", enabled: true, role: "assistant" },
		] });
		const app = conversationApp(database);
		const url = `http://localhost/api/conversations/${chat.id}/prompt-preset`;
		const before = await (await app.handle(new Request(url))).json();
		const response = await app.handle(new Request(`${url}?presetId=${preset.id}`));
		expect(response.status).toBe(200);
		const read = await response.json();
		expect(read.id).toBe(preset.id);
		expect(read.slots).toContainEqual(expect.objectContaining({ reference: "model-identity", sourceName: "Maren" }));
		expect(await (await app.handle(new Request(url))).json()).toEqual(before);
		expect((await app.handle(new Request(`${url}?presetId=999999`))).status).toBe(404);
	} finally { database.close(); }
});

test("a provider rejection before streaming returns its Brief error", async () => {
	const database = openObservedDatabase();
	try {
		const chat = createConversationWithHistory(database, { name: "Scene", participants: [
			{ definition: { name: "Writer", prompt: humanPrompt, sendAppearanceImages: true, openings: [] } },
			{ definition: { name: "Maren", prompt: modelPrompt, sendAppearanceImages: true, openings: ["A scene"] } },
		], control: { human: 0, model: 1 } });
		withProfile(database);
		const routes = createPaintingRoutes(database, { masterKey: key, fetch: async () => Response.json({ error: { message: "Brief quota exceeded" } }, { status: 429 }) });
		const response = await routes.handle(new Request(`http://localhost/api/conversations/${chat.id}/brief`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ variantId: chat.messages[0]!.variants[0]!.id, ask: "Describe this." }),
		}));
		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({ outcome: "invalid", reason: "The provider request failed with HTTP 429." });
	} finally { database.close(); }
});

test("a Brief pins its target Variant after a swipe and reads only its own preset's Macro State without writing it", async () => {
	const database = openObservedDatabase();
	try {
		const chat = createConversationWithHistory(database, { name: "Scene", participants: [
			{ definition: { name: "Writer", prompt: humanPrompt, sendAppearanceImages: true, openings: [] } },
			{ definition: { name: "Maren", prompt: modelPrompt, sendAppearanceImages: true, openings: ["Original lantern", "Swiped lake"] } },
		], control: { human: 0, model: 1 } });
		withProfile(database);
		const preset = importNativePromptPreset(database, { name: "Both", slots: [
			{ reference: "history", enabled: true },
			{ reference: "brief-instruction", enabled: true, role: "user", content: "Tone: {{getvar::tone}}." },
		] });
		const message = chat.messages[0]!;
		const original = message.variants[0]!;
		const swiped = message.variants[1]!;
		const selected = executeConversationCommand(database, { conversationId: chat.id, expectedRevision: chat.revision, action: { type: "select-prompt-preset", promptPresetId: preset.id } });
		for (const [variantId, tone] of [[original.id, "warm"], [swiped.id, "cold"]] as const) {
			const entry = macroWritesToData(preset.id, [{ operation: "set", name: "tone", value: tone }]);
			if (!entry) throw new Error("Macro fixture missing");
			database.query("INSERT INTO message_variant_data (message_variant_id, namespace, key, value) VALUES (?, ?, ?, ?)").run(variantId, entry.namespace, entry.key, entry.value);
		}
		executeConversationCommand(database, { conversationId: chat.id, expectedRevision: selected.revision, action: { type: "select-variant", messageId: message.id, variantId: swiped.id } });
		const paintings = createPaintingModule(database);
		paintings.command(chat.id, { type: "select-paint-preset", paintPresetId: preset.id });
		const before = requireSnapshot(database, chat.id);
		const rows = database.query("SELECT * FROM message_variant_data").all();
		const requests: CapturedRequest[] = [];
		const write = () => Array.fromAsync(writeBrief(database, chat.id, { variantId: original.id, ask: "Paint this." },
			{ masterKey: key, fetch: captureModelFetch((request) => requests.push(request)) }, new AbortController().signal));
		await write();
		expect(requests[0]!.messages).toEqual([
			{ role: "assistant", content: "Original lantern" },
			{ role: "user", content: "Tone: warm." },
			{ role: "user", content: "Paint this." },
		]);
		const paintOnly = importNativePromptPreset(database, { name: "Paint only", slots: [
			{ reference: "brief-instruction", enabled: true, role: "user", content: "Before: {{getvar::tone}}; local: {{setvar::local::ink}}{{getvar::local}}." },
		] });
		paintings.command(chat.id, { type: "select-paint-preset", paintPresetId: paintOnly.id });
		await write();
		expect(requests[1]!.messages[0]).toEqual({ role: "user", content: "Before: ; local: ink." });
		expect(requireSnapshot(database, chat.id)).toEqual(before);
		expect(database.query("SELECT * FROM message_variant_data").all()).toEqual(rows);
	} finally { database.close(); }
});


test("a Brief preserves a provider failure after content has started streaming", async () => {
	const database = openObservedDatabase();
	try {
		const chat = createConversationWithHistory(database, { name: "Scene", participants: [
			{ definition: { name: "Writer", prompt: humanPrompt, sendAppearanceImages: true, openings: [] } },
			{ definition: { name: "Maren", prompt: modelPrompt, sendAppearanceImages: true, openings: ["A scene"] } },
		], control: { human: 0, model: 1 } });
		withProfile(database);
		const chunks = [
			{ id: "brief", choices: [{ index: 0, delta: { content: "A lantern" }, finish_reason: null }] },
			{ error: { message: "The provider stopped this Brief." } },
		];
		const routes = createPaintingRoutes(database, { masterKey: key, fetch: async () => new Response(
			chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } },
		) });
		const response = await routes.handle(new Request(`http://localhost/api/conversations/${chat.id}/brief`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ variantId: chat.messages[0]!.variants[0]!.id, ask: "Describe this." }),
		}));
		expect(response.status).toBe(200);
		const frames = (await response.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
		expect(frames).toContainEqual({ type: "content", text: "A lantern" });
		expect(frames).toContainEqual({ type: "failed", kind: "provider", message: expect.stringContaining("The provider stopped this Brief.") });
	} finally { database.close(); }
});


test("a Brief reads unseated Cast Appearance by name or authorship and sends only anchors when its switch is off", async () => {
	const database = openObservedDatabase();
	try {
		const image = await uploadImage(database, pngFixture());
		const chat = createConversationWithHistory(database, { name: "Cast scene", participants: [
			{ definition: { name: "Writer", prompt: humanPrompt, sendAppearanceImages: true, openings: [] } },
			{ definition: { name: "Maren", prompt: { ...modelPrompt, appearance: "A red cloak beside {{other}}." }, sendAppearanceImages: true, openings: ["Iris waits on the bridge."] } },
			{ definition: { name: "Iris", prompt: { ...modelPrompt, appearance: `{{self}} has silver hair. ${formatImageReference("Silver hair", image.hash)}` }, sendAppearanceImages: false, openings: [] } },
			{ definition: { name: "Nora", prompt: { ...modelPrompt, appearance: "A blue scarf." }, sendAppearanceImages: true, openings: [] } },
			{ definition: { name: "Absent", prompt: { ...modelPrompt, appearance: "Must not be sent." }, sendAppearanceImages: true, openings: [] } },
		], control: { human: 0, model: 1 } });
		withProfile(database);
		const requests: CapturedRequest[] = [];
		await Array.fromAsync(writeBrief(database, chat.id, { variantId: chat.messages[0]!.variants[0]!.id, ask: "Paint Nora beside her." },
			{ masterKey: key, fetch: captureModelFetch((request) => requests.push(request)) }, new AbortController().signal));
		const sent = JSON.stringify(requests[0]!.messages);
		expect(sent).toContain("Maren\\nA red cloak beside Writer.");
		expect(sent).toContain("Iris\\nIris has silver hair. [Image: Silver hair]");
		expect(sent).toContain("Nora\\nA blue scarf.");
		expect(sent).not.toContain("Must not be sent.");
		expect(sent).not.toContain("image_url");
		const nora = chat.cast.find((participant) => participant.name === "Nora")!;
		database.query("UPDATE messages SET author_participant_id = ?, author_name = 'A witness' WHERE id = ?").run(nora.id, chat.messages[0]!.id);
		await Array.fromAsync(writeBrief(database, chat.id, { variantId: chat.messages[0]!.variants[0]!.id, ask: "Paint the bridge." },
			{ masterKey: key, fetch: captureModelFetch((request) => requests.push(request)) }, new AbortController().signal));
		expect(JSON.stringify(requests[1]!.messages)).toContain("Nora\\nA blue scarf.");
		database.query("UPDATE participant_prompt SET send_appearance_images = 1 WHERE participant_id = ?").run(chat.cast.find((participant) => participant.name === "Iris")!.id);
		await Array.fromAsync(writeBrief(database, chat.id, { variantId: chat.messages[0]!.variants[0]!.id, ask: "Paint the bridge." },
			{ masterKey: key, fetch: captureModelFetch((request) => requests.push(request)) }, new AbortController().signal));
		expect(JSON.stringify(requests[2]!.messages)).toContain(`data:image/png;base64,${pngFixture().toString("base64")}`);
	} finally { database.close(); }
});
