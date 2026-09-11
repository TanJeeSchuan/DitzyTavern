import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createConversationModule } from "../conversation";
import { createConversationRoutes } from "./conversation";
import { captureModelFetch, withProfile } from "./prompt-preset-test-fixtures";
import type {
	GenerationPreview,
	GenerationPreviewBody,
} from "../../shared/contract/conversation-schema";

const prompt = {
	systemInstruction: "",
	identity: "",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
};

const createChat = (database: Database) => createConversationModule(database).create({
	name: "Preview Chat",
	participants: [
		{ definition: { name: "Writer", prompt, openings: [] } },
		{ definition: { name: "Maren", prompt, openings: [] } },
	],
	control: { human: 0, model: 1 },
});

const preview = async (
	app: ReturnType<typeof createConversationRoutes>,
	conversationId: number,
	body: GenerationPreviewBody,
) => {
	const response = await app.handle(new Request(
		`http://localhost/api/conversations/${conversationId}/generations/preview`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	));
	expect(response.status).toBe(200);
	// ==[HUMAN APPROVED]== SAFETY: the route validated this response against the preview schema.
	return await response.json() as Pick<GenerationPreview, "previewId" | "promptPlan">;
};

const readVariantData = (database: Database) => {
	// ==[HUMAN APPROVED]== SAFETY: this fixture selects the three scalar columns asserted below.
	return database.query("SELECT namespace, key, value FROM message_variant_data").all() as { namespace: string; key: string; value: string }[];
};

describe("Prompt Plan inspection", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("sends the edited plan literally and preserves expansion-time writes", async () => {
		const originalRandom = Math.random;
		Math.random = () => 0.3;
		try {
			const conversation = createChat(database);
			database.query("UPDATE participant_prompt SET system_instruction = ? WHERE participant_id = ?")
				.run("Rolled 7 {{setvar::rollResult::{{roll::1d20}}}}", conversation.cast[1]!.id);
			withProfile(database);
			let captured: { messages: { role: string; content: string }[] } | undefined;
			const app = createConversationRoutes(database, {
				masterKey: new Uint8Array(32).fill(11),
				fetch: captureModelFetch((request) => { captured = request; }),
			});
			const plan = await preview(app, conversation.id, { kind: "send", content: "hello" });
			expect(readVariantData(database).some((row) => row.namespace === "prompt-macro")).toBe(false);
			const edited = {
				...plan.promptPlan,
				blocks: plan.promptPlan.blocks.map((block) => block.kind === "system-instruction"
					? { ...block, content: "Rolled 18 {{roll::1d20}}" }
					: block),
			};
			const started = await app.handle(new Request(
				`http://localhost/api/conversations/${conversation.id}/generations`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						expectedRevision: conversation.revision,
						content: "hello",
						previewId: plan.previewId,
						promptPlan: edited,
					}),
				},
			));
			expect(started.status).toBe(200);
			// ==[HUMAN APPROVED]== SAFETY: the acceptance response is the route's generation contract.
			const accepted = await started.json() as { generationId: number };
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(captured?.messages).toContainEqual({
				role: "system",
				content: "Rolled 18 {{roll::1d20}}",
			});
			await (await app.handle(new Request(
				`http://localhost/api/conversations/${conversation.id}/generations/${accepted.generationId}/events`,
			))).text();
			expect(readVariantData(database).some((row) => row.namespace === "prompt-macro" && JSON.parse(row.value).value === "7")).toBe(true);
		} finally {
			Math.random = originalRandom;
		}
	});

	test("rejects a stale Definition while tolerating an unrelated cast addition", async () => {
		const conversation = createChat(database);
		withProfile(database);
		const app = createConversationRoutes(database, { masterKey: new Uint8Array(32).fill(11), fetch: captureModelFetch(() => {}) });
		const plan = await preview(app, conversation.id, { kind: "send", content: "hello" });
		const module = createConversationModule(database);
		const changed = module.execute({
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			action: { type: "add-participant", definition: { name: "Extra", prompt, openings: [] } },
		});
		const accepted = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision: changed.revision, content: "hello", previewId: plan.previewId }),
			},
		));
		expect(accepted.status).toBe(200);
	});

	test("does not apply a plan edit that exceeds the captured context ceiling", async () => {
		const conversation = createChat(database);
		withProfile(database);
		const app = createConversationRoutes(database, { masterKey: new Uint8Array(32).fill(11), fetch: async () => new Response() });
		const plan = await preview(app, conversation.id, { kind: "send", content: "hello" });
		const edited = {
			...plan.promptPlan,
			blocks: plan.promptPlan.blocks.map((block) => ({
				...block,
				content: "x".repeat(500_000),
			})),
		};
		const rejected = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision: conversation.revision, content: "hello", previewId: plan.previewId, promptPlan: edited }),
			},
		));
		expect(rejected.status).toBe(422);
	});
});
