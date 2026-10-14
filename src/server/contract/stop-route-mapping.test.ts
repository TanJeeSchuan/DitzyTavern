import { createConversationWithHistory } from "../test-fixtures/conversation";
import { acceptConversationSiblingGeneration } from "../conversation";
import { openObservedDatabase } from "../test-fixtures/conversation";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { generationRuntimeFor } from "../workflows";
import { createConversationRoutes } from "./conversation";

const prompt = {
	systemInstruction: "Answer briefly.",
	identity: "I am {{self}}.",
	scenario: "The room is quiet.",
	exampleDialogue: "",
	postHistoryInstruction: "Continue.",
};

// Route tests own one responsibility only: mapping typed Generation lifecycle
// outcomes onto transport responses. Ordering, races, and settlement belong to
// the Coordinator tests; these routes run against the real deep Conversation
// module and the real process runtime registry, so every mapped response is
// produced by the production lifecycle itself.

describe("Generation Stop route mapping", () => {
	let database: Database;

	beforeEach(() => {
		database = openObservedDatabase();
	});

	afterEach(() => database.close());

	const setup = () => {
		const module = database;
		const conversation = createConversationWithHistory(module, {
			name: "Stop mapping",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: ["Original."] } },
			],
			control: { human: 0, model: 1 },
		});
		const human = conversation.cast[0];
		const model = conversation.cast[1];
		if (human === undefined || model === undefined) throw new Error("Control Participants missing.");
		return { module, conversation, human, model };
	};

	const acceptSibling = (input: ReturnType<typeof setup>, messageId: number, timestamp: string) =>
		acceptConversationSiblingGeneration(input.module, {
			seed: "test-generation-seed",
			conversationId: input.conversation.id,
			messageId,
			timestamp,
			humanParticipantId: input.human.id,
			modelParticipantId: input.model.id,
			capturedModelName: input.model.name,
			promptPlan: { blocks: [], warnings: [], images: [] },
			promptInspection: { tokenEstimate: 0, responseBudget: 64, safetyAllowance: 0, contextLimit: 128, totalRequiredTokens: 64, omittedContext: [] },
			promptContext: [],
			generationSettings: {},
			connection: {},
		});

	const startRuntime = (
		conversationId: number,
		accepted: { generationId: number; messageId: number; provisionalVariantId: number },
	) =>
		generationRuntimeFor(database).start({
			generationId: accepted.generationId,
			conversationId,
			messageId: accepted.messageId,
			variantId: accepted.provisionalVariantId,
			startedAt: "2026-08-27T00:00:00.000Z",
		});

	const stopRoute = (conversationId: number, generationId: number) =>
		createConversationRoutes(database).handle(
			new Request(`http://localhost/api/conversations/${conversationId}/generations/${generationId}/stop`, {
				method: "POST",
				body: "{}",
			}),
		);

	const stopAllRoute = (conversationId: number) =>
		createConversationRoutes(database).handle(
			new Request(`http://localhost/api/conversations/${conversationId}/generations/stop-all`, {
				method: "POST",
				body: "{}",
			}),
		);

	test("maps a missing Generation onto the not-found transport response", async () => {
		const input = setup();

		const response = await stopRoute(input.conversation.id, 404_404);
		// SAFETY: this test controls the mapped not-found response shape.
		const body = await response.json() as { outcome: string };

		expect(response.status).toBe(404);
		expect(body.outcome).toBe("not-found");
	});

	test("maps a stopped Stop All onto the stopped transport response", async () => {
		const input = setup();
		const target = input.conversation.messages[0];
		if (target === undefined) throw new Error("Opening target missing.");
		const first = acceptSibling(input, target.id, "2026-08-27T00:00:01.000Z");
		const second = acceptSibling(input, target.id, "2026-08-27T00:00:02.000Z");
		startRuntime(input.conversation.id, first);
		startRuntime(input.conversation.id, second);

		const response = await stopAllRoute(input.conversation.id);
		// SAFETY: this test controls the mapped response shape.
		const body = await response.json() as {
			outcome: string;
			generationIds: number[];
			conversation: { id: number };
		};

		expect(response.status).toBe(200);
		expect(body.outcome).toBe("stopped");
		expect(body.generationIds).toEqual([first.generationId, second.generationId]);
		expect(body.conversation.id).toBe(input.conversation.id);
	});

	test("maps a missing Stop All onto the not-found transport response", async () => {
		const input = setup();

		const response = await stopAllRoute(input.conversation.id);
		// SAFETY: this test controls the mapped not-found response shape.
		const body = await response.json() as { outcome: string };

		expect(response.status).toBe(404);
		expect(body.outcome).toBe("not-found");
	});
});
