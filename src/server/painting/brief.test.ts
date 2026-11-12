import { humanPrompt, modelPrompt } from "../contract/prompt-preset-test-fixtures";
import { createConversationWithHistory } from "../test-fixtures/conversation";
import { createPaintingRoutes } from "../contract/painting";
import { formatImageReference } from "../../shared/image-reference";
import { pngFixture } from "../image/image-fixtures";
import { uploadImage } from "../image";
import { expect, test, setSystemTime } from "bun:test";
import { openObservedDatabase, requireSnapshot } from "../test-fixtures/conversation";
import { createChat, withProfile, captureModelFetch, key, type CapturedRequest } from "../contract/prompt-preset-test-fixtures";
import { importNativePromptPreset } from "../prompt-preset";
import { createPaintingModule } from ".";
import { writeBrief } from "./brief";

test("a Brief uses its Paint Preset, the last N selected Messages ending at the target, matching Lore and a literal final Ask without storing output", async () => {
	const database = openObservedDatabase();
	setSystemTime(new Date("2026-06-15T02:00:00Z"));
	try {
		const chat = createChat(database);
		withProfile(database);
		for (const [index, content] of ["Outside the window", "River lantern", "At the bridge", "Later scene"].entries()) {
			const message = database.query<{ id: number }, [number, number, number, string]>("INSERT INTO messages (conversation_id, position, timestamp, author_participant_id, author_name) VALUES (?, ?, '', ?, ?) RETURNING id")
				.get(chat.id, index + 1, chat.control.modelParticipantId!, "Maren")!;
			database.query("INSERT INTO message_variant (message_id, position, content, timestamp, selected) VALUES (?, 1, ?, '', 1)").run(message.id, content);
		}
		const snapshot = requireSnapshot(database, chat.id);
		const preset = importNativePromptPreset(database, { name: "Paint only", slots: [
			{ reference: "lore", enabled: true, role: "system" },
			{ reference: "history", enabled: true },
			{ reference: "box:world-clock", enabled: true, role: "system", content: "Box must not run." },
			{ reference: "brief-instruction", enabled: true, role: "assistant", content: "Paint {{self}} in charcoal on {{date}}. {{setvar::temporary::changed}}" },
			{ reference: "instruction", enabled: true, role: "system", name: "End", content: "Last preset block." },
		] });
		const paintings = createPaintingModule(database);
		paintings.command(chat.id, { type: "select-paint-preset", paintPresetId: preset.id });
		paintings.command(chat.id, { type: "set-brief-message-count", briefMessageCount: 2 });
		database.exec(`INSERT INTO lorebook (id, name) VALUES (1, 'River');
			INSERT INTO lorebook_entry (lorebook_id, position, title, content, keywords_json) VALUES (1, 1, 'Lantern', 'The lantern is green.', '["lantern"]'), (1, 2, 'Future', 'Wrong future Lore.', '["Later"]');`);
		database.query("INSERT INTO conversation_lorebook_attachment (conversation_id, lorebook_id) VALUES (?, 1)").run(chat.id);
		const before = requireSnapshot(database, chat.id);
		const rows = database.query("SELECT * FROM conversation_data").all();
		const requests: CapturedRequest[] = [];
		const events = await Array.fromAsync(writeBrief(database, chat.id, { variantId: snapshot.messages[2]!.variants[0]!.id, ask: "Focus on {{self}} at the bridge.", locale: "fr-FR", timeZone: "Pacific/Honolulu" },
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
		expect(requests[0]!.messages.at(-1)).toEqual({ role: "user", content: "Describe the scene at Message 1, the final Message in the supplied history." });
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
		expect((await write(chat.id)).status).toBe(422);
	} finally { database.close(); }
});
