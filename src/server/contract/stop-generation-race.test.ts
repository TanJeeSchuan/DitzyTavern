import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../database/database";
import { createConversationModule } from "../conversation";
import { generationRuntimeFor, type GenerationRuntime } from "../workflows/generation-runtime";
import { createConversationRoutes } from "./conversation";

const prompt = {
	systemInstruction: "Answer briefly.",
	identity: "I am {{self}}.",
	scenario: "The room is quiet.",
	exampleDialogue: "",
	postHistoryInstruction: "Continue.",
};

describe("Generation Stop terminal races", () => {
	let database: Database;

	beforeEach(() => { database = openDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	const setup = () => {
		const module = createConversationModule(database);
		const conversation = module.create({
			name: "Terminal race",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		const human = conversation.cast[0];
		const model = conversation.cast[1];
		if (human === undefined || model === undefined) throw new Error("Control Participants missing.");
		return { module, conversation, human, model };
	};

	test("Stop releases terminal ownership when the provider wins during cancellation", async () => {
		const input = setup();
		const accepted = input.module.acceptTailGeneration({
			conversationId: input.conversation.id,
			expectedRevision: input.conversation.revision,
			timestamp: "2026-08-27T00:00:00.000Z",
			humanContent: "Finish this.",
			humanParticipantId: input.human.id,
			modelParticipantId: input.model.id,
			capturedModelName: input.model.name,
			promptPlan: {},
			historyRoles: [],
			generationSettings: {},
			connection: {},
		});
		let runtime!: GenerationRuntime;
		const terminalStates: string[] = [];
		runtime = generationRuntimeFor(database).start({
			generationId: accepted.generationId,
			conversationId: input.conversation.id,
			messageId: accepted.modelMessageId,
			variantId: accepted.provisionalVariantId,
			startedAt: "2026-08-27T00:00:00.000Z",
			onStop: () => {
				input.module.resolveTailGeneration({
					conversationId: input.conversation.id,
					generationId: accepted.generationId,
					timestamp: "2026-08-27T00:00:01.000Z",
					content: "Provider won.",
				});
				runtime.complete();
			},
		});
		runtime.onStateChange((state) => {
			if (state.status !== "active") terminalStates.push(state.status);
		});

		const response = await createConversationRoutes(database).handle(new Request(
			`http://localhost/api/conversations/${input.conversation.id}/generations/${accepted.generationId}/stop`,
			{ method: "POST", body: "{}" },
		));

		expect(response.status).toBe(404);
		expect(runtime.state.status).toBe("complete");
		expect(terminalStates).toEqual(["complete"]);
		const snapshot = input.module.getSnapshot(input.conversation.id);
		expect(snapshot?.activeGenerations).toEqual([]);
		expect(snapshot?.messages.at(-1)?.variants).toHaveLength(1);
		expect(snapshot?.messages.at(-1)?.variants[0]?.content).toBe("Provider won.");
		expect(snapshot?.messages.at(-1)?.variants[0]?.data).not.toContainEqual(
			{ namespace: "generation", key: "outcome", value: "interrupted" },
		);
	});

	test("Stop All commits every target before settling provider runtimes", async () => {
		const input = setup();
		const generated = input.module.commitGeneration({
			conversationId: input.conversation.id,
			timestamp: "2026-08-27T00:00:00.000Z",
			content: "Original.",
			authorParticipantId: input.model.id,
			capturedAuthorName: input.model.name,
			humanParticipantId: input.human.id,
			modelParticipantId: input.model.id,
		});
		const target = generated.messages.at(-1);
		if (target === undefined) throw new Error("Generated target missing.");
		const acceptSibling = (timestamp: string) => input.module.acceptSiblingGeneration({
			conversationId: input.conversation.id,
			messageId: target.id,
			timestamp,
			humanParticipantId: input.human.id,
			modelParticipantId: input.model.id,
			capturedModelName: input.model.name,
			promptPlan: {},
			historyRoles: [],
			generationSettings: {},
			connection: {},
		});
		const providerWinner = acceptSibling("2026-08-27T00:00:01.000Z");
		const stopWinner = acceptSibling("2026-08-27T00:00:02.000Z");
		let providerRuntime!: GenerationRuntime;
		providerRuntime = generationRuntimeFor(database).start({
			generationId: providerWinner.generationId,
			conversationId: input.conversation.id,
			messageId: providerWinner.messageId,
			variantId: providerWinner.provisionalVariantId,
			startedAt: "2026-08-27T00:00:01.000Z",
			onStop: () => {
				// Stop All must secure the durable Conversation transition before
				// asking this provider attempt to abort.
				expect(input.module.getSnapshot(input.conversation.id)?.activeGenerations).toEqual([]);
			},
		});
		const stopRuntime = generationRuntimeFor(database).start({
			generationId: stopWinner.generationId,
			conversationId: input.conversation.id,
			messageId: stopWinner.messageId,
			variantId: stopWinner.provisionalVariantId,
			startedAt: "2026-08-27T00:00:02.000Z",
		});
		const providerTerminalStates: string[] = [];
		const stopTerminalStates: string[] = [];
		providerRuntime.onStateChange((state) => {
			if (state.status !== "active") providerTerminalStates.push(state.status);
		});
		stopRuntime.onStateChange((state) => {
			if (state.status !== "active") stopTerminalStates.push(state.status);
		});

		const response = await createConversationRoutes(database).handle(new Request(
			`http://localhost/api/conversations/${input.conversation.id}/generations/stop-all`,
			{ method: "POST", body: "{}" },
		));
		// SAFETY: this contract test controls the Stop All response and checks its
		// successful status immediately below before using the documented shape.
		const payload = await response.json() as { generationIds: number[] };

		expect(response.status).toBe(200);
		expect(payload.generationIds).toEqual([providerWinner.generationId, stopWinner.generationId]);
		expect(providerRuntime.state.status).toBe("stopped");
		expect(stopRuntime.state.status).toBe("stopped");
		expect(providerTerminalStates).toEqual(["stopped"]);
		expect(stopTerminalStates).toEqual(["stopped"]);
		const snapshot = input.module.getSnapshot(input.conversation.id);
		expect(snapshot?.activeGenerations).toEqual([]);
		expect(snapshot?.messages[0]?.variants.map((variant) => variant.content)).toEqual(["Original."]);
		expect(snapshot?.messages[0]?.variants.filter((variant) => variant.selected)).toHaveLength(1);
	});
});
