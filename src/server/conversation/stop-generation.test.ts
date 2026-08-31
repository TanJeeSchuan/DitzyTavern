import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../database/database";
import {
	acceptConversationSiblingGeneration,
	acceptConversationTailGeneration,
	checkpointConversationSiblingGeneration,
	checkpointConversationTailGeneration,
	createConversationModule,
} from ".";
// The raw durable stop transitions are private implementation details of the
// Conversation module; only these durable-transaction tests reach them
// directly. Production stop flows compose them through the Generation
// Coordinator's application interface.
import {
	stopConversationGeneration,
	stopConversationGenerations,
} from "./commands/active-generation";
import { recoverActiveGenerations } from "../workflows";

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
				{ definition: { name: "Maren", prompt, openings: ["Original answer."] } },
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
		if (modelMessage === undefined || variant === undefined) throw new Error("Interrupted Variant missing.");

		expect(stopped.activeGenerations).toEqual([]);
		expect(stopped.messages).toHaveLength(3);
		expect(variant.content).toBe("Partial answer.");
		expect(variant.data).toEqual([
			{ namespace: "generation", key: "interruption-cause", value: "user-stop" },
			{ namespace: "generation", key: "outcome", value: "interrupted" },
			{ namespace: "generation", key: "reasoning", value: "Private thought." },
		]);
		expect(input.module.readVariantDetails(
			input.created.id,
			modelMessage.id,
			variant.id,
		)?.provenance).toMatchObject({
			status: "interrupted",
			finishReason: null,
			interruptionCause: "user-stop",
		});
	});

	test("restart recovery retains its interruption cause on the recovered Variant", () => {
		const input = setup();
		const accepted = acceptTail(input);
		checkpointConversationTailGeneration(database, {
			conversationId: input.created.id,
			generationId: accepted.generationId,
			content: "Recovered partial answer.",
			latestEventId: 2,
		});

		expect(recoverActiveGenerations(database)).toEqual({
			inspected: 1,
			interrupted: 1,
			removed: 0,
			failed: 0,
		});
		const recoveredMessage = input.module.getSnapshot(input.created.id)?.messages.at(-1);
		const recoveredVariant = recoveredMessage?.variants[0];
		if (recoveredMessage === undefined || recoveredVariant === undefined) {
			throw new Error("Recovered Variant missing.");
		}
		expect(input.module.readVariantDetails(
			input.created.id,
			recoveredMessage.id,
			recoveredVariant.id,
		)?.provenance).toMatchObject({
			status: "interrupted",
			finishReason: null,
			interruptionCause: "server-restart",
		});
	});

	test("removes zero-output Tail targets while preserving the human input", () => {
		const input = setup();
		const accepted = acceptTail(input, "Keep my input.");

		const stopped = stopConversationGeneration(database, {
			conversationId: input.created.id,
			generationId: accepted.generationId,
		});

		expect(stopped.activeGenerations).toEqual([]);
		expect(stopped.messages).toHaveLength(2);
		expect(stopped.messages.at(-1)?.variants[0]?.content).toBe("Keep my input.");
	});

	// The sibling target is the configured opening Message: a native Message
	// whose captured historical Control pair makes sibling acceptance
	// eligible without any terminal-commit setup.
	const acceptSibling = (input: ReturnType<typeof setup>) => {
		const target = input.created.messages[0];
		if (target === undefined) throw new Error("Opening target missing.");
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
		const stoppedMessage = stopped.messages[0];
		const stoppedVariant = variants[1];
		if (stoppedMessage === undefined || stoppedVariant === undefined) {
			throw new Error("Stopped Sibling Variant missing.");
		}

		expect(stopped.activeGenerations).toEqual([]);
		expect(variants).toHaveLength(2);
		expect(variants.find((variant) => variant.selected)?.content).toBe("Alternative answer.");
		expect(variants[1]?.data).toEqual([
			{ namespace: "generation", key: "interruption-cause", value: "user-stop" },
			{ namespace: "generation", key: "outcome", value: "interrupted" },
		]);
		expect(input.module.readVariantDetails(
			input.created.id,
			stoppedMessage.id,
			stoppedVariant.id,
		)?.provenance).toMatchObject({
			status: "interrupted",
			finishReason: null,
			interruptionCause: "user-stop",
		});
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

	test("stops every active Sibling target in one revisioned transition", () => {
		const input = setup();
		const target = input.created.messages[0];
		if (target === undefined) throw new Error("Opening target missing.");
		const accept = (timestamp: string) => input.module.acceptSiblingGeneration({
			conversationId: input.created.id,
			messageId: target.id,
			timestamp,
			humanParticipantId: input.humanId,
			modelParticipantId: input.modelId,
			capturedModelName: input.modelName,
			promptPlan: {},
			historyRoles: [],
			generationSettings: {},
			connection: {},
		});
		const first = accept("2026-08-27T00:00:01.000Z");
		const second = accept("2026-08-27T00:00:02.000Z");
		const revisionBeforeStop = input.module.getSnapshot(input.created.id)?.revision;

		const stopped = stopConversationGenerations(database, {
			conversationId: input.created.id,
			timestamp: "2026-08-27T00:00:03.000Z",
		});

		expect(stopped.generationIds).toEqual([first.generationId, second.generationId]);
		expect(stopped.conversation.activeGenerations).toEqual([]);
		expect(stopped.conversation.revision).toBe((revisionBeforeStop ?? 0) + 1);
		expect(stopped.conversation.messages[0]?.variants).toHaveLength(1);
		expect(stopped.conversation.messages[0]?.variants[0]?.selected).toBe(true);
		expect(stopped.conversation.messages[0]?.variants[0]?.content).toBe("Original answer.");
	});
});
