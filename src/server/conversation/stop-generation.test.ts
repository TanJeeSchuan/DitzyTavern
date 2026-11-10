import { readTestConversationSnapshot, createConversationWithHistory, checkpointFromStart } from "../test-fixtures/conversation";
import { editMacroVariables, readMacroVariables, executeConversationCommand, readVariantDetails, acceptConversationSiblingGeneration } from "./index";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
	acceptConversationTailGeneration,
} from ".";
// The raw durable stop transitions are private implementation details of the
// Conversation module; only these durable-transaction tests reach them
// directly. Production stop flows compose them through the Generation
// Coordinator's application interface.
import {
	stopConversationGeneration,
	stopConversationGenerations,
} from "./commands/active-generation";
import { openObservedDatabase, requireSnapshot } from "../test-fixtures/conversation";

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
		database = openObservedDatabase();
	});

	afterEach(() => database.close());

	const setup = () => {
		const module = database;
		const created = createConversationWithHistory(module, {
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
			seed: "test-generation-seed",
			conversationId: input.created.id,
			expectedRevision: input.created.revision,
			timestamp: "2026-08-27T00:00:00.000Z",
			humanContent: content,
			humanParticipantId: input.humanId,
			modelParticipantId: input.modelId,
			capturedHumanName: "Writer",
			capturedModelName: input.modelName,
			promptPlan: { blocks: [], warnings: [], images: [] },
			modelId: "fixture-model", promptInspection: { tokenEstimate: 0, responseBudget: 64, safetyAllowance: 0, contextLimit: 128, totalRequiredTokens: 64, omittedContext: [] },
		});

	test("persists partial Tail output as an interrupted Variant", () => {
		const input = setup();
		const accepted = acceptTail(input);
		checkpointFromStart(database, {
			conversationId: input.created.id,
			generationId: accepted.generationId,
			content: "Partial answer.",
			reasoning: "Private thought.",
			latestEventId: 3,
		});

		stopConversationGeneration(database, {
			conversationId: input.created.id,
			generationId: accepted.generationId,
			timestamp: "2026-08-27T00:00:01.000Z",
		});
		const stopped = readTestConversationSnapshot(database, input.created.id)!;
		const modelMessage = stopped.messages.at(-1);
		const variant = modelMessage?.variants[0];
		if (modelMessage === undefined || variant === undefined) throw new Error("Interrupted Variant missing.");

		expect(stopped.activeGenerations).toEqual([]);
		expect(stopped.messages).toHaveLength(3);
		expect(variant.content).toBe("Partial answer.");
		expect(variant.data).toEqual([
			{ namespace: "box", key: "seed", value: expect.any(String) },
			{ namespace: "generation", key: "interruption-cause", value: "user-stop" },
			{ namespace: "generation", key: "outcome", value: "interrupted" },
			{ namespace: "generation", key: "reasoning", value: "Private thought." },
		]);
		expect(readVariantDetails(input.module,
			input.created.id,
			modelMessage.id,
			variant.id,
		)?.provenance).toMatchObject({
			status: "interrupted",
			finishReason: null,
			interruptionCause: "user-stop",
		});
	});

	test("removes zero-output Tail targets while preserving the human input", () => {
		const input = setup();
		const accepted = acceptTail(input, "Keep my input.");

		stopConversationGeneration(database, {
			conversationId: input.created.id,
			generationId: accepted.generationId,
		});
		const stopped = readTestConversationSnapshot(database, input.created.id)!;

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
			seed: "test-generation-seed",
			conversationId: input.created.id,
			messageId: target.id,
			timestamp: "2026-08-27T00:00:01.000Z",
			humanParticipantId: input.humanId,
			modelParticipantId: input.modelId,
			capturedHumanName: "Writer",
			capturedModelName: input.modelName,
			promptPlan: { blocks: [], warnings: [], images: [] },
			modelId: "fixture-model", promptInspection: { tokenEstimate: 0, responseBudget: 64, safetyAllowance: 0, contextLimit: 128, totalRequiredTokens: 64, omittedContext: [] },
		});
	};

	for (const target of ["human-message", "model-message", "historical-message"] as const) {
		test(`deleting a ${target} cannot orphan a running Tail Generation`, () => {
			const input = setup();
			const accepted = acceptTail(input);
			const before = requireSnapshot(database, input.created.id);
			const messageId = target === "human-message" ? before.messages.at(-2)!.id
				: target === "model-message" ? accepted.messageId : before.messages[0]!.id;
			expect(() => executeConversationCommand(database, {
				conversationId: input.created.id, expectedRevision: before.revision,
				action: { type: "delete-message", messageId },
			})).toThrow("Stop the running Generation before deleting Messages or Variants.");
			checkpointFromStart(database, { conversationId: input.created.id, generationId: accepted.generationId, content: "Still owned." });
			stopConversationGeneration(database, { conversationId: input.created.id, generationId: accepted.generationId });
			expect(requireSnapshot(database, input.created.id).messages.at(-1)?.variants[0]?.content).toBe("Still owned.");
		});
	}

	for (const target of ["provisional", "prior"] as const) {
		test(`deleting a ${target} Sibling Variant cannot invalidate a running Generation`, () => {
			const input = setup();
			const accepted = acceptSibling(input);
			const variantId = target === "provisional" ? accepted.provisionalVariantId : input.created.messages[0]!.variants[0]!.id;
			expect(() => executeConversationCommand(database, {
				conversationId: input.created.id, expectedRevision: accepted.conversation.revision,
				action: { type: "delete-variant", messageId: accepted.messageId, variantId },
			})).toThrow("Stop the running Generation before deleting Messages or Variants.");
			stopConversationGeneration(database, { conversationId: input.created.id, generationId: accepted.generationId });
			expect(requireSnapshot(database, input.created.id).messages[0]?.variants).toMatchObject([{ content: "Original answer.", selected: true }]);
		});
	}

	test("Macro edits cannot be overwritten by a provisional Variant's captured writes", () => {
		const input = setup();
		const accepted = acceptTail(input);
		const position = requireSnapshot(database, input.created.id).messages.at(-1)!.position;
		const edit = (position: number, expectedRevision: number) => editMacroVariables(database, {
			conversationId: input.created.id, expectedRevision, position, promptPresetId: 1,
			operation: "set", name: "mood", value: "writer value",
		});
		expect(() => edit(position, accepted.conversation.revision)).toThrow("Macro Variables cannot change on a Variant while its Generation is running.");
		const initial = edit(0, accepted.conversation.revision);
		expect(readMacroVariables(database, input.created.id)?.variables).toMatchObject([{ name: "mood", value: "writer value" }]);
		expect(() => edit(1, initial.conversation.revision)).not.toThrow();
	});

	test("keeps partial Sibling output selected and marks it interrupted", () => {
		const input = setup();
		const accepted = acceptSibling(input);
		checkpointFromStart(database, {
			conversationId: input.created.id,
			generationId: accepted.generationId,
			content: "Alternative answer.",
			latestEventId: 1,
		});

		stopConversationGeneration(database, {
			conversationId: input.created.id,
			generationId: accepted.generationId,
		});
		const stopped = readTestConversationSnapshot(database, input.created.id)!;
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
			{ namespace: "box", key: "seed", value: "test-generation-seed" },
			{ namespace: "generation", key: "interruption-cause", value: "user-stop" },
			{ namespace: "generation", key: "outcome", value: "interrupted" },
		]);
		expect(readVariantDetails(input.module,
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

		stopConversationGeneration(database, {
			conversationId: input.created.id,
			generationId: accepted.generationId,
		});
		const stopped = readTestConversationSnapshot(database, input.created.id)!;
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
		const accept = (timestamp: string) => acceptConversationSiblingGeneration(input.module, {
			seed: "test-generation-seed",
			conversationId: input.created.id,
			messageId: target.id,
			timestamp,
			humanParticipantId: input.humanId,
			modelParticipantId: input.modelId,
			capturedHumanName: "Writer",
			capturedModelName: input.modelName,
			promptPlan: { blocks: [], warnings: [], images: [] },
			modelId: "fixture-model", promptInspection: { tokenEstimate: 0, responseBudget: 64, safetyAllowance: 0, contextLimit: 128, totalRequiredTokens: 64, omittedContext: [] },
		});
		const first = accept("2026-08-27T00:00:01.000Z");
		const second = accept("2026-08-27T00:00:02.000Z");
		const revisionBeforeStop = readTestConversationSnapshot(input.module, input.created.id)?.revision;

		const stopped = stopConversationGenerations(database, {
			conversationId: input.created.id,
			timestamp: "2026-08-27T00:00:03.000Z",
		});

		expect(stopped.generationIds).toEqual([first.generationId, second.generationId]);
		expect(stopped.conversation.activeGenerations).toEqual([]);
		expect(stopped.conversation.revision).toBe((revisionBeforeStop ?? 0) + 1);
		const surviving = requireSnapshot(input.module, input.created.id).messages[0]?.variants;
		expect(surviving).toHaveLength(1);
		expect(surviving?.[0]?.selected).toBe(true);
		expect(surviving?.[0]?.content).toBe("Original answer.");
	});
});
