import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../database/database";
import {
	acceptConversationContinuationGeneration,
	acceptConversationSiblingGeneration,
	acceptConversationTailGeneration,
	createConversationModule,
	InvalidConversationCommandError,
} from ".";

// Regression tests for canonical Generation removal. The Active Generation
// row is the only authority for which mutation a removal performs: a Sibling
// Generation loses its provisional Variant, while Tail and Continuation
// Generations lose their whole provisional Message. A caller-supplied mode
// used to override that authority and let a Tail-mode removal delete the
// Message owning every Sibling Variant.
describe("canonical Conversation Generation removal", () => {
	let database: Database;

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
	});

	afterEach(() => database.close());

	const setup = () => {
		const module = createConversationModule(database);
		const created = module.create({
			name: "Removal Chat",
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

	test("removing a Sibling Generation keeps its owning Message and every surviving Variant", () => {
		const input = setup();
		const target = input.created.messages[0];
		if (target === undefined) throw new Error("Opening target missing.");
		const before = input.module.getSnapshot(input.created.id);
		if (before === undefined) throw new Error("Snapshot missing.");
		const accepted = acceptSibling(input);

		input.module.removeGeneration({
			conversationId: input.created.id,
			generationId: accepted.generationId,
		});

		const after = input.module.getSnapshot(input.created.id);
		if (after === undefined) throw new Error("Snapshot missing.");
		// The destructive audit repro: one Message before, zero after.
		expect(after.messages).toHaveLength(before.messages.length);
		const survivor = after.messages[0];
		expect(survivor?.id).toBe(target.id);
		expect(survivor?.variants).toHaveLength(1);
		expect(survivor?.variants[0]?.content).toBe("Original answer.");
		expect(survivor?.variants[0]?.selected).toBe(true);
		expect(after.activeGenerations).toEqual([]);
		expect(after.revision).toBe(accepted.conversation.revision + 1);
	});

	test("removing a Tail Generation removes its provisional Message and keeps the accepted human input", () => {
		const input = setup();
		const accepted = acceptConversationTailGeneration(database, {
			conversationId: input.created.id,
			expectedRevision: input.created.revision,
			timestamp: "2026-08-27T00:00:00.000Z",
			humanContent: "Keep my input.",
			humanParticipantId: input.humanId,
			modelParticipantId: input.modelId,
			capturedModelName: input.modelName,
			promptPlan: {},
			historyRoles: [],
			generationSettings: {},
			connection: {},
		});

		input.module.removeGeneration({
			conversationId: input.created.id,
			generationId: accepted.generationId,
		});

		const after = input.module.getSnapshot(input.created.id);
		if (after === undefined) throw new Error("Snapshot missing.");
		expect(after.activeGenerations).toEqual([]);
		expect(after.messages).toHaveLength(2);
		expect(after.messages.at(-1)?.variants[0]?.content).toBe("Keep my input.");
		expect(after.revision).toBe(accepted.conversation.revision + 1);
	});

	test("removing a Continuation Generation removes only its provisional Message", () => {
		const input = setup();
		const opening = input.created.messages[0];
		const openingVariant = opening?.variants[0];
		if (opening === undefined || openingVariant === undefined) throw new Error("Opening missing.");
		const accepted = acceptConversationContinuationGeneration(database, {
			conversationId: input.created.id,
			expectedRevision: input.created.revision,
			timestamp: "2026-08-27T00:00:00.000Z",
			precedingMessageId: opening.id,
			precedingVariantId: openingVariant.id,
			humanParticipantId: input.humanId,
			modelParticipantId: input.modelId,
			capturedModelName: input.modelName,
			promptPlan: {},
			historyRoles: [],
			generationSettings: {},
			connection: {},
		});

		input.module.removeGeneration({
			conversationId: input.created.id,
			generationId: accepted.generationId,
		});

		const after = input.module.getSnapshot(input.created.id);
		if (after === undefined) throw new Error("Snapshot missing.");
		expect(after.activeGenerations).toEqual([]);
		expect(after.messages).toHaveLength(1);
		expect(after.messages[0]?.id).toBe(opening.id);
		expect(after.messages[0]?.variants[0]?.content).toBe("Original answer.");
		expect(after.revision).toBe(accepted.conversation.revision + 1);
	});

	test("removal keeps an explicit Sibling selection made while the attempt ran", () => {
		const input = setup();
		const target = input.created.messages[0];
		const priorVariant = target?.variants[0];
		if (target === undefined || priorVariant === undefined) throw new Error("Opening target missing.");
		const accepted = acceptSibling(input);

		// The user explicitly restores the prior Variant while the attempt
		// runs; that selection outranks the acceptance-time snapshot.
		const selected = input.module.execute({
			conversationId: input.created.id,
			expectedRevision: accepted.conversation.revision,
			action: { type: "select-variant", messageId: target.id, variantId: priorVariant.id },
		});

		input.module.removeGeneration({
			conversationId: input.created.id,
			generationId: accepted.generationId,
		});

		const after = input.module.getSnapshot(input.created.id);
		if (after === undefined) throw new Error("Snapshot missing.");
		expect(after.messages).toHaveLength(1);
		expect(after.messages[0]?.variants).toHaveLength(1);
		expect(after.messages[0]?.variants[0]?.id).toBe(priorVariant.id);
		expect(after.messages[0]?.variants[0]?.selected).toBe(true);
		expect(after.revision).toBe(selected.revision + 1);
	});

	test("blocks create-variant from deselecting an active Provisional Variant while selection remains available", () => {
		const input = setup();
		const target = input.created.messages[0];
		const priorVariant = target?.variants[0];
		if (target === undefined || priorVariant === undefined) throw new Error("Opening target missing.");
		const accepted = acceptSibling(input);

		expect(() =>
			input.module.execute({
				conversationId: input.created.id,
				expectedRevision: accepted.conversation.revision,
				action: {
					type: "create-variant",
					messageId: target.id,
					content: "Should not displace the active target.",
				},
			}),
		).toThrow(
			"A new Conversation turn, Variant creation, or Control mutation is unavailable while an Active Generation exists.",
		);

		const selected = input.module.execute({
			conversationId: input.created.id,
			expectedRevision: accepted.conversation.revision,
			action: {
				type: "select-variant",
				messageId: target.id,
				variantId: priorVariant.id,
			},
		});
		expect(selected.messages[0]?.variants).toHaveLength(2);
		expect(selected.messages[0]?.variants[0]?.selected).toBe(true);
		expect(selected.activeGenerations).toEqual(accepted.conversation.activeGenerations);
	});

	test("removing an unknown Generation id is rejected", () => {
		const input = setup();
		expect(() =>
			input.module.removeGeneration({
				conversationId: input.created.id,
				generationId: 999999,
			})
		).toThrow(InvalidConversationCommandError);
	});
});

const prompt = {
	systemInstruction: "Answer briefly.",
	identity: "I am {{self}}.",
	scenario: "The room is quiet.",
	exampleDialogue: "",
	postHistoryInstruction: "Continue.",
};
