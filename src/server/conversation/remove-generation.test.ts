import { openObservedDatabase } from "./test-fixtures";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { activeGenerationTable } from "../database/schema";
import {
	acceptConversationContinuationGeneration,
	acceptConversationSiblingGeneration,
	acceptConversationTailGeneration,
	createConversationModule,
	InvalidConversationCommandError,
} from ".";

import { observeConversationWrites } from "./commands/transaction";
import type { ConversationMemoryChange } from "../../shared/contract/conversation-memory-change";
// Regression tests for canonical Generation removal. The Active Generation
// row is the only authority for which mutation a removal performs: a Sibling
// Generation loses its provisional Variant, while Tail and Continuation
// Generations lose their whole provisional Message. A caller-supplied mode
// used to override that authority and let a Tail-mode removal delete the
// Message owning every Sibling Variant.
describe("canonical Conversation Generation removal", () => {
	let database: Database;

	beforeEach(() => {
		database = openObservedDatabase();
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
			promptPlan: { blocks: [], warnings: [], images: [] },
			promptContext: [],
			generationSettings: {},
			connection: {},
		});
	};

	test("removing earlier siblings preserves the rollback selection of later siblings", () => {
		const input = setup();
		const first = acceptSibling(input);
		const second = acceptSibling(input);
		input.module.removeGeneration({ conversationId: input.created.id, generationId: first.generationId });
		input.module.removeGeneration({ conversationId: input.created.id, generationId: second.generationId });
		const surviving = input.module.getSnapshot(input.created.id)?.messages[0]?.variants;
		expect(surviving).toHaveLength(1);
		expect(surviving?.[0]?.content).toBe("Original answer.");
		expect(surviving?.[0]?.selected).toBe(true);
	});

	test("removal refuses a checkpointed target so cleanup cannot erase durable output", () => {
		const input = setup();
		const accepted = acceptSibling(input);
		input.module.checkpointGeneration({
			conversationId: input.created.id,
			generationId: accepted.generationId,
			content: "Keep this output.",
		});
		expect(() => input.module.removeGeneration({
			conversationId: input.created.id,
			generationId: accepted.generationId,
		})).toThrow("A Generation with durable output must be resolved or stopped.");
		const after = input.module.getSnapshot(input.created.id);
		expect(after?.activeGenerations).toHaveLength(1);
		expect(after?.messages[0]?.variants.at(-1)?.content).toBe("Keep this output.");
	});

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
			promptPlan: { blocks: [], warnings: [], images: [] },
			promptContext: [],
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

	test("removals report their removed Variant ids so Memory can abandon the work the write deleted", () => {
	const input = setup();
	const delivered: ConversationMemoryChange[] = [];
	// The per-database registration is the same seam the application or the
	// test composition installs once; a specific case may scope a finer
	// observer for the write it inspects.
	observeConversationWrites(database, (_observedDatabase, change: ConversationMemoryChange) => {
		delivered.push(change);
	});

	// A Sibling Generation loses exactly its provisional Variant.
	const sibling = acceptSibling(input);
	delivered.splice(0);
	input.module.removeGeneration({ conversationId: input.created.id, generationId: sibling.generationId });
	expect(delivered).toHaveLength(1);
	expect([...delivered[0]?.removedVariantIds ?? []]).toEqual([sibling.provisionalVariantId]);
	expect(delivered[0]?.touchedVariantIds).toEqual([]);

	// A Tail Generation loses its whole provisional Message: one Variant. The
	// acceptance seam reports the accepted human source separately; the
	// removal report is drained and asserted on its own.
	const revision = input.module.getRevision(input.created.id);
	if (revision === undefined) throw new Error("Conversation missing.");
	const tail = acceptConversationTailGeneration(database, {
		conversationId: input.created.id,
		expectedRevision: revision,
		timestamp: "2026-08-27T00:00:02.000Z",
		humanContent: "Keep my input.",
		humanParticipantId: input.humanId,
		modelParticipantId: input.modelId,
		capturedModelName: input.modelName,
		promptPlan: { blocks: [], warnings: [], images: [] },
		promptContext: [],
		generationSettings: {},
		connection: {},
	});
	delivered.splice(0);
	input.module.removeGeneration({ conversationId: input.created.id, generationId: tail.generationId });
	expect(delivered).toHaveLength(1);
	expect([...delivered[0]?.removedVariantIds ?? []]).toEqual([tail.provisionalVariantId]);
	expect(delivered[0]?.touchedVariantIds).toEqual([]);
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
			promptPlan: { blocks: [], warnings: [], images: [] },
			promptContext: [],
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
		input.module.execute({
			conversationId: input.created.id,
			expectedRevision: accepted.conversation.revision,
			action: { type: "select-variant", messageId: target.id, variantId: priorVariant.id },
		});
		const selected = input.module.getSnapshot(input.created.id)!;

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

		input.module.execute({
			conversationId: input.created.id,
			expectedRevision: accepted.conversation.revision,
			action: {
				type: "select-variant",
				messageId: target.id,
				variantId: priorVariant.id,
			},
		});
		const selected = input.module.getSnapshot(input.created.id)!;
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

	test("rejects malformed persisted Generation intent without Tail-style deletion", () => {
		const input = setup();
		const accepted = acceptSibling(input);
		drizzle(database)
			.update(activeGenerationTable)
			.set({ generation_intent_json: "{}" })
			.where(eq(activeGenerationTable.id, accepted.generationId))
			.run();

		expect(() => input.module.removeGeneration({
			conversationId: input.created.id,
			generationId: accepted.generationId,
		})).toThrow("invalid persisted Generation intent");

		const after = input.module.getSnapshot(input.created.id);
		if (after === undefined) throw new Error("Snapshot missing.");
		expect(after.messages).toHaveLength(1);
		expect(after.messages[0]?.variants).toHaveLength(2);
		expect(after.activeGenerations).toHaveLength(1);
	});
});

const prompt = {
	systemInstruction: "Answer briefly.",
	identity: "I am {{self}}.",
	scenario: "The room is quiet.",
	exampleDialogue: "",
	postHistoryInstruction: "Continue.",
};
