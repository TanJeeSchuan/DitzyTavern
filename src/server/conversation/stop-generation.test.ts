import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../database/database";
import {
	acceptConversationSiblingGeneration,
	acceptConversationTailGeneration,
	checkpointConversationSiblingGeneration,
	checkpointConversationTailGeneration,
	createConversationModule,
	stopConversationGeneration,
} from ".";

const prompt = {
	systemInstruction: "Answer briefly.",
	identity: "I am {{self}}.",
	scenario: "The room is quiet.",
	exampleDialogue: "",
	postHistoryInstruction: "Continue.",
};

describe("explicit Conversation Generation Stop", () => {
	let database: Database;

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
	});

	afterEach(() => database.close());

	const setup = () => {
		const module = createConversationModule(database);
		const created = module.create({
			name: "Stop Chat",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		const human = created.cast[0];
		const model = created.cast[1];
		if (human === undefined || model === undefined) throw new Error("Control Participants missing.");
		return { module, created, humanId: human.id, modelId: model.id, modelName: model.name };
	};

	const acceptTail = (input: ReturnType<typeof setup>, content = "Try this.") =>
		acceptConversationTailGeneration(database, {
			conversationId: input.created.id,
			expectedRevision: input.created.revision,
			timestamp: "2026-08-27T00:00:00.000Z",
			humanContent: content,
			humanParticipantId: input.humanId,
			modelParticipantId: input.modelId,
			capturedModelName: input.modelName,
			promptPlan: {},
			historyRoles: [],
			generationSettings: {},
			connection: {},
		});

	test("persists partial Tail output as an interrupted Variant", () => {
		const input = setup();
		const accepted = acceptTail(input);
		checkpointConversationTailGeneration(database, {
			conversationId: input.created.id,
			generationId: accepted.generationId,
			content: "Partial answer.",
			reasoning: "Private thought.",
			latestEventId: 3,
		});

		const stopped = stopConversationGeneration(database, {
			conversationId: input.created.id,
			generationId: accepted.generationId,
			timestamp: "2026-08-27T00:00:01.000Z",
		});
		const modelMessage = stopped.messages.at(-1);
		const variant = modelMessage?.variants[0];
		if (variant === undefined) throw new Error("Interrupted Variant missing.");

		expect(stopped.activeGenerations).toEqual([]);
		expect(stopped.messages).toHaveLength(2);
		expect(variant.content).toBe("Partial answer.");
		expect(variant.data).toEqual([
			{ namespace: "generation", key: "interruption-cause", value: "user-stop" },
			{ namespace: "generation", key: "outcome", value: "interrupted" },
			{ namespace: "generation", key: "reasoning", value: "Private thought." },
		]);
	});

	test("removes zero-output Tail targets while preserving the human input", () => {
		const input = setup();
		const accepted = acceptTail(input, "Keep my input.");

		const stopped = stopConversationGeneration(database, {
			conversationId: input.created.id,
			generationId: accepted.generationId,
		});

		expect(stopped.activeGenerations).toEqual([]);
		expect(stopped.messages).toHaveLength(1);
		expect(stopped.messages[0]?.variants[0]?.content).toBe("Keep my input.");
	});

	const acceptSibling = (input: ReturnType<typeof setup>) => {
		const generated = input.module.commitGeneration({
			conversationId: input.created.id,
			timestamp: "2026-08-27T00:00:00.000Z",
			content: "Original answer.",
			authorParticipantId: input.modelId,
			capturedAuthorName: input.modelName,
			humanParticipantId: input.humanId,
			modelParticipantId: input.modelId,
		});
		const target = generated.messages.at(-1);
		if (target === undefined) throw new Error("Generated target missing.");
		return acceptConversationSiblingGeneration(database, {
			conversationId: input.created.id,
			messageId: target.id,
			timestamp: "2026-08-27T00:00:01.000Z",
			humanParticipantId: input.humanId,
			modelParticipantId: input.modelId,
			capturedModelName: input.modelName,
			promptPlan: {},
			historyRoles: [],
			generationSettings: {},
			connection: {},
		});
	};

	test("keeps partial Sibling output selected and marks it interrupted", () => {
		const input = setup();
		const accepted = acceptSibling(input);
		checkpointConversationSiblingGeneration(database, {
			conversationId: input.created.id,
			generationId: accepted.generationId,
			content: "Alternative answer.",
			latestEventId: 1,
		});

		const stopped = stopConversationGeneration(database, {
			conversationId: input.created.id,
			generationId: accepted.generationId,
		});
		const variants = stopped.messages[0]?.variants ?? [];

		expect(stopped.activeGenerations).toEqual([]);
		expect(variants).toHaveLength(2);
		expect(variants.find((variant) => variant.selected)?.content).toBe("Alternative answer.");
		expect(variants[1]?.data).toEqual([
			{ namespace: "generation", key: "interruption-cause", value: "user-stop" },
			{ namespace: "generation", key: "outcome", value: "interrupted" },
		]);
	});

	test("removes zero-output Sibling targets and restores the prior selection", () => {
		const input = setup();
		const accepted = acceptSibling(input);

		const stopped = stopConversationGeneration(database, {
			conversationId: input.created.id,
			generationId: accepted.generationId,
		});
		const variants = stopped.messages[0]?.variants ?? [];

		expect(stopped.activeGenerations).toEqual([]);
		expect(variants).toHaveLength(1);
		expect(variants[0]?.selected).toBe(true);
		expect(variants[0]?.content).toBe("Original answer.");
	});
});
