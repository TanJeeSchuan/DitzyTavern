import { afterEach, expect, test } from "bun:test";
import { openInitializedDatabase } from "../../server/database/database";
import { createConversationModule } from "../../server/conversation";
import { pngFixture } from "../../server/image/image-fixtures";
import { ingestUploads } from "../../server/image";
import { formatImageReference } from "../../shared/image-reference";
import { ImageDraft, hasLocalImage, imageSrc, prepareImage, withInlineImages } from "./image";

const owners: ImageDraft[] = [];
const owner = () => { const draft = new ImageDraft(); owners.push(draft); return draft; };
afterEach(() => { for (const draft of owners.splice(0)) draft.dispose(); });

test("undo restores bytes after an edit deletes the last persisted reference", async () => {
	const database = openInitializedDatabase({ path: ":memory:" });
	try {
		const module = createConversationModule(database);
		const prompt = { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" };
		const chat = module.create({ name: "Chat", participants: [{ definition: { name: "Writer", prompt, openings: [] } }, { definition: { name: "Maren", prompt, openings: [] } }], control: { human: 0, model: 1 } });
		const draft = owner();
		const { hash } = await prepareImage(new File([pngFixture()], "map.png", { type: "image/png" }), draft);
		const content = formatImageReference("map", hash);
		const write = async (action: Parameters<typeof module.execute>[0]["action"]) => withInlineImages(JSON.stringify(action), async (images) => {
			module.execute({ conversationId: chat.id, expectedRevision: module.getRevision(chat.id)!, action, images: await ingestUploads(images ?? []) });
			return { error: null };
		});
		await write({ type: "create-message", timestamp: "2026-10-05T00:00:00Z", authorParticipantId: chat.cast[0]!.id, variantContents: [content] });
		const message = module.getSnapshot(chat.id)!.messages[0]!;
		const edit = { type: "edit-variant" as const, messageId: message.id, variantId: message.variants[0]!.id };
		await write({ ...edit, content: "Removed" });
		expect(database.query("SELECT hash FROM image").all()).toEqual([]);
		await write({ ...edit, content });
		expect(database.query("SELECT hash FROM image").all()).toEqual([{ hash }]);
		draft.dispose();
		expect(hasLocalImage(hash)).toBe(false);
		expect(imageSrc(hash)).toBe(`/api/images/${hash}`);
	} finally { database.close(); }
});

test("cancelled uploads release previews only after their last draft owner closes", async () => {
	const first = owner();
	const second = owner();
	const { hash } = await prepareImage(new File([pngFixture({ width: 2 })], "portrait.png"), first);
	second.setHashes([hash]);
	first.dispose();
	let bytes: string[] | undefined;
	await withInlineImages(JSON.stringify({ portrait: { hash } }), async (images) => { bytes = images; return { error: null }; });
		expect(bytes).toHaveLength(1);
	second.dispose();
	await withInlineImages(JSON.stringify({ portrait: { hash } }), async (images) => { bytes = images; return { error: null }; });
		expect(bytes).toBeUndefined();
		expect(hasLocalImage(hash)).toBe(false);
});

test("a write waits for existing draft bytes before it can remove the persisted reference", async () => {
	const originalFetch = globalThis.fetch;
	const hash = "f".repeat(64);
	let finish: ((response: Response) => void) | undefined;
	globalThis.fetch = Object.assign(() => new Promise<Response>((resolve) => { finish = resolve; }), originalFetch);
	try {
		const draft = owner();
		draft.setHashes([hash]);
		let sent = false;
		const write = withInlineImages("Removed", async () => { sent = true; return { error: null }; });
		await Promise.resolve();
		expect(sent).toBe(false);
		finish!(new Response(pngFixture()));
		await write;
		let bytes: string[] | undefined;
		await withInlineImages(formatImageReference("map", hash), async (images) => { bytes = images; return { error: null }; });
		expect(bytes).toHaveLength(1);
		draft.dispose();
		expect(hasLocalImage(hash)).toBe(false);
	} finally { globalThis.fetch = originalFetch; }
});
