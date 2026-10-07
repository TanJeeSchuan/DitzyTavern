import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createContract } from ".";
import { createConversationModule } from "../conversation";
import { uploadImage } from "../image";
import { pngFixture } from "../image/image-fixtures";
import { formatImageReference } from "../../shared/image-reference";
import { generationPreview, generationAccepted } from "../../shared/contract/conversation-schema";
import type { GenerationPreview, GenerationPreviewBody, GenerationBody, PromptPlan } from "../../shared/contract/conversation-schema";
import { captureModelFetch, key, withProfile } from "./prompt-preset-test-fixtures";

const prompt = { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" };
const post = (app: ReturnType<typeof createContract>, path: string, body: GenerationPreviewBody | GenerationBody) => app.handle(new Request(`http://localhost/api${path}`, {
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

describe("Edited Prompt Plan Images", () => {
	let database: Database;
	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => { database.close(); });

	test("sends a copied Image unknown to the original preview once the edited plan is accepted", async () => {
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
		const accepted = await post(app, `/conversations/${chat.id}/generations`, { expectedRevision: chat.revision, content: "Look", previewId: preview.previewId, promptPlan: edited });
		expect(accepted.status).toBe(200);
		const { generationId } = Value.Decode(generationAccepted, await accepted.json());
		await (await app.handle(new Request(`http://localhost/api/conversations/${chat.id}/generations/${generationId}/events`))).text();
		expect(captured).toMatchObject({ messages: [{ role: "user", content: [
			{ type: "text", text: "Writer: Look [Image: map]" },
			{ type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}` } },
		] }] });
	});
});
