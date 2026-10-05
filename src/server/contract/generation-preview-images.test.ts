import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import type { Static } from "@sinclair/typebox";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createContract } from ".";
import { createConversationModule } from "../conversation";
import { createConnectionSettingsModule } from "../connection-settings";
import { clearGenerationPreviewRegistry } from "../workflows/generation-preview";
import { uploadImage } from "../image";
import { pngFixture } from "../image/image-fixtures";
import { formatImageReference } from "../../shared/image-reference";
import { generationPreview, generationAccepted, generationPreviewImagesBody } from "../../shared/contract/conversation-schema";
import type { GenerationPreview, GenerationPreviewBody, GenerationBody, PromptPlan } from "../../shared/contract/conversation-schema";
import { captureModelFetch, key, withProfile } from "./prompt-preset-test-fixtures";

const prompt = { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" };
const post = (app: ReturnType<typeof createContract>, path: string, body: GenerationPreviewBody | GenerationBody | Static<typeof generationPreviewImagesBody>) => app.handle(new Request(`http://localhost/api${path}`, {
	method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));
const addImage = (plan: PromptPlan, content: string): PromptPlan => ({
	...plan,
	blocks: plan.blocks.map((block) => block.kind === "history" ? { ...block, content } : block),
});

const inspect = async (app: ReturnType<typeof createContract>, id: number): Promise<GenerationPreview> => {
	const response = await post(app, `/conversations/${id}/generations/preview`, { kind: "send", content: "Look" });
	expect(response.status).toBe(200);
	return Value.Decode(generationPreview, await response.json());
};

const createChat = (database: Database) => createConversationModule(database).create({
	name: "Images", participants: [
		{ definition: { name: "Writer", prompt, openings: [] } },
		{ definition: { name: "Maren", prompt, openings: [] } },
	], control: { human: 0, model: 1 },
});

describe("Edited Prompt Plan Image inspection", () => {
	let database: Database;
	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => { clearGenerationPreviewRegistry(database); database.close(); });

	test("reports a copied Image unknown to the original preview as sent, then sends its bytes on acceptance", async () => {
		const source = createChat(database);
		const bytes = pngFixture({ width: 100, height: 100 });
		const image = await uploadImage(database, bytes);
		const reference = formatImageReference("map", image.hash);
		createConversationModule(database).execute({ conversationId: source.id, expectedRevision: source.revision, action: {
			type: "create-message", timestamp: "2026-10-05T00:00:00Z", variantContents: [reference], authorParticipantId: source.cast[0]!.id,
		} });
		const chat = createChat(database);
		withProfile(database);
		let captured: unknown;
		const app = createContract(database, { masterKey: key, fetch: captureModelFetch((request) => { captured = request; }) });
		const preview = await inspect(app, chat.id);
		expect(preview.promptPlan.images).toEqual([]);
		const edited = addImage(preview.promptPlan, `Look ${reference}`);
		const checked = await post(app, `/conversations/${chat.id}/generations/preview/images`, { previewId: preview.previewId, promptPlan: edited });
		expect(checked.status).toBe(200);
		expect(await checked.json()).toEqual({ images: [{ block: 0, start: 5, hash: image.hash, name: "map", disposition: "send", tokens: 14 }] });
		const accepted = await post(app, `/conversations/${chat.id}/generations`, { expectedRevision: chat.revision, content: "Look", previewId: preview.previewId, promptPlan: edited });
		expect(accepted.status).toBe(200);
		const { generationId } = Value.Decode(generationAccepted, await accepted.json());
		await (await app.handle(new Request(`http://localhost/api/conversations/${chat.id}/generations/${generationId}/events`))).text();
		expect(captured).toMatchObject({ messages: [{ role: "user", content: [
			{ type: "text", text: "Writer: Look [Image: map]" },
			{ type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}` } },
		] }] });
	});

	test("resolves edits with captured placement, missing warnings and text-only policy, ignoring submitted dispositions", async () => {
		const chat = createChat(database);
		const bytes = pngFixture({ width: 100, height: 100 });
		const image = await uploadImage(database, bytes);
		const reference = formatImageReference("map", image.hash);
		const profile = withProfile(database).profiles[0]!;
		const app = createContract(database, { masterKey: key });
		const preview = await inspect(app, chat.id);
		const edited = addImage(preview.promptPlan, `${reference} ${reference} ${formatImageReference("ghost", "f".repeat(64))}`);
		edited.images = [{ block: 0, start: 0, hash: image.hash, name: "map", disposition: "missing", tokens: 0 }];
		const checked = await post(app, `/conversations/${chat.id}/generations/preview/images`, { previewId: preview.previewId, promptPlan: edited });
		expect(checked.status).toBe(200);
		expect(await checked.json()).toMatchObject({ images: [
			{ disposition: "anchor", tokens: 14 }, { disposition: "send", tokens: 14 }, { disposition: "missing", tokens: 0 },
		] });
		createConnectionSettingsModule(database, { masterKey: key }).setTextOnlyModel({ profileId: profile.id, modelId: preview.effectiveSettings.modelId, textOnly: true });
		const textOnly = await inspect(app, chat.id);
		const textOnlyChecked = await post(app, `/conversations/${chat.id}/generations/preview/images`, { previewId: textOnly.previewId, promptPlan: addImage(textOnly.promptPlan, edited.blocks[0]!.content) });
		expect(textOnlyChecked.status).toBe(200);
		expect(await textOnlyChecked.json()).toMatchObject({ images: [
			{ disposition: "text-only", tokens: 0 }, { disposition: "text-only", tokens: 0 }, { disposition: "missing", tokens: 0 },
		] });
	});

	test("rejects inspection with another Chat's preview or an edited block structure", async () => {
		const chat = createChat(database);
		const other = createChat(database);
		withProfile(database);
		const app = createContract(database, { masterKey: key });
		const preview = await inspect(app, chat.id);
		const cases: [number, PromptPlan][] = [[other.id, preview.promptPlan], [chat.id, { ...preview.promptPlan, blocks: [] }]];
		for (const [id, promptPlan] of cases) {
			const response = await post(app, `/conversations/${id}/generations/preview/images`, { previewId: preview.previewId, promptPlan });
			expect(response.status).toBe(422);
			expect(await response.json()).toMatchObject({ outcome: "invalid" });
		}
	});
});
