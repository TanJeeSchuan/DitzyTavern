import { readTestConversationSnapshot, checkpointFromStart, shortReplyPrompt, pairChat } from "../test-fixtures/conversation";
import { executeConversationCommand, acceptGeneration, resolveConversationGeneration, readActiveGenerationDetails, readVariantDetails, stopConversationGeneration } from ".";
import { openObservedDatabase } from "../test-fixtures/conversation";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { BoxTraces } from "../../shared/contract/box-generation";

const prompt = shortReplyPrompt({ scenario: "A quiet room." });

// @approved
//  A captured Box's trace as the host keeps it; the host never reads `trace`.
const traces = (messageId: number, variantId: number, finalText = "Maren still has the key."): BoxTraces => ({
	"box:memory": {
		trace: { scene: "Maren asks for the key.", sources: [{ messageId, variantId }] },
		allowance: 1024,
		items: [{ text: "Maren keeps the brass key.", admission: "admitted" }],
		automaticText: "Maren keeps the brass key.",
		finalText,
	},
});

const createChat = (database: Database) => {

	const created = pairChat(database, "Box traces", { prompt });
	executeConversationCommand(database, {
		conversationId: created.id,
		expectedRevision: created.revision,
		action: { type: "create-message", timestamp: "2026-09-23T00:00:00.000Z", variantContents: ["Maren kept the brass key."], selectedVariantIndex: 0, authorParticipantId: created.cast[1]!.id },
	});
	return readTestConversationSnapshot(database, created.id)!;
};

const acceptedInput = (conversation: ReturnType<typeof createChat>, boxTraces: BoxTraces, timestamp = "2026-09-23T00:01:00.000Z") => ({
	seed: "test-generation-seed",
	conversationId: conversation.id,
	timestamp,
	humanParticipantId: conversation.cast[0]!.id,
	modelParticipantId: conversation.cast[1]!.id,
	capturedHumanName: "Writer",
	capturedModelName: "Maren",
	promptPlan: { blocks: [{ kind: "box:memory" as const, role: "system" as const, content: boxTraces["box:memory"]!.finalText }], warnings: [], images: [] },
	boxTraces,
	modelId: "fixture-model", promptInspection: { tokenEstimate: 0, responseBudget: 64, safetyAllowance: 0, contextLimit: 128, totalRequiredTokens: 64, omittedContext: [] },
});

describe("permanent Box traces", () => {
	let database: Database;

	beforeEach(() => {
		database = openObservedDatabase();
	});
	afterEach(() => database.close());

	test("retain the exact attempt after source changes and replay expiry", () => {
		const created = createChat(database);
		const source = created.messages[0]!;
		const sourceVariant = source.variants[0]!;
		const captured = traces(source.id, sourceVariant.id);

		const accepted = acceptGeneration(database, acceptedInput(created, captured), { kind: "send", expectedRevision: created.revision, content: "Ask about the key." });
		expect(readActiveGenerationDetails(database, created.id, accepted.generationId)?.boxTraces).toEqual(captured);

		resolveConversationGeneration(database, { conversationId: created.id, generationId: accepted.generationId, timestamp: "2026-09-23T00:02:00.000Z", content: "Maren pockets the key." });
		const generated = readTestConversationSnapshot(database, created.id)!.messages.at(-1)!;
		const generatedVariant = generated.variants.at(-1)!;
		expect(readVariantDetails(database, created.id, generated.id, generatedVariant.id)?.boxTraces).toEqual(captured);

		const revision = readTestConversationSnapshot(database, created.id)!.revision;
		executeConversationCommand(database, { conversationId: created.id, expectedRevision: revision, action: { type: "edit-variant", messageId: source.id, variantId: sourceVariant.id, content: "Maren returned the key." } });
		const afterEdit = readVariantDetails(database, created.id, generated.id, generatedVariant.id)!;
		expect(afterEdit.boxTraces).toEqual(captured);

		const beforeDeleteRevision = readTestConversationSnapshot(database, created.id)!.revision;
		executeConversationCommand(database, { conversationId: created.id, expectedRevision: beforeDeleteRevision, action: { type: "delete-message", messageId: source.id } });
		const afterDeletion = readVariantDetails(database, created.id, generated.id, generatedVariant.id)!;
		expect(afterDeletion.boxTraces).toEqual(captured);

		database.run("UPDATE generation_replay SET expires_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", accepted.generationId]);
		expect(readActiveGenerationDetails(database, created.id, accepted.generationId)).toBeUndefined();
		const historicalDetails = () => readVariantDetails(database, created.id, generated.id, generatedVariant.id);
		expect(historicalDetails()?.boxTraces).toEqual(captured);

		database.run("UPDATE message_variant_data SET value = ? WHERE message_variant_id = ? AND namespace = ? AND key = ?", ["{", generatedVariant.id, "generation-box", "traces"]);
		expect(historicalDetails).toThrow("Persisted Box traces are not valid JSON.");

		database.run("UPDATE message_variant_data SET value = ? WHERE message_variant_id = ? AND namespace = ? AND key = ?", ["[]", generatedVariant.id, "generation-box", "traces"]);
		expect(historicalDetails).toThrow("Persisted Box traces do not match their schema.");
	});

	test("give each sibling its own record and keep interrupted output while removing empty targets", () => {
		const created = createChat(database);
		const source = created.messages[0]!;
		const captured = traces(source.id, source.variants[0]!.id);

		const base = acceptGeneration(database, acceptedInput(created, captured), { kind: "send", expectedRevision: created.revision, content: "Ask about the key." });
		resolveConversationGeneration(database, { conversationId: created.id, generationId: base.generationId, timestamp: "2026-09-23T00:02:00.000Z", content: "Maren pockets the key." });
		const baseMessage = readTestConversationSnapshot(database, created.id)!.messages.at(-1)!;
		const siblingTraces = (finalText: string) => traces(source.id, source.variants[0]!.id, finalText);
		const acceptSibling = (record: BoxTraces) => acceptGeneration(database,
			acceptedInput(created, record, "2026-09-23T00:03:00.000Z"),
			{ kind: "sibling", messageId: baseMessage.id },
		);
		const firstTraces = siblingTraces("The first captured edit.");
		const first = acceptSibling(firstTraces);
		resolveConversationGeneration(database, { conversationId: created.id, generationId: first.generationId, timestamp: "2026-09-23T00:04:00.000Z", content: "First alternative." });
		const secondTraces = siblingTraces("The second captured edit.");
		const second = acceptSibling(secondTraces);
		resolveConversationGeneration(database, { conversationId: created.id, generationId: second.generationId, timestamp: "2026-09-23T00:05:00.000Z", content: "Second alternative." });
		expect(readVariantDetails(database, created.id, baseMessage.id, first.provisionalVariantId)?.boxTraces).toEqual(firstTraces);
		expect(readVariantDetails(database, created.id, baseMessage.id, second.provisionalVariantId)?.boxTraces).toEqual(secondTraces);
		const revision = readTestConversationSnapshot(database, created.id)!.revision;
		executeConversationCommand(database, { conversationId: created.id, expectedRevision: revision, action: { type: "delete-variant", messageId: baseMessage.id, variantId: first.provisionalVariantId } });
		expect(readVariantDetails(database, created.id, baseMessage.id, first.provisionalVariantId)).toBeUndefined();
		expect(readVariantDetails(database, created.id, baseMessage.id, second.provisionalVariantId)?.boxTraces).toEqual(secondTraces);
		expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);

		const interruptedBase = readTestConversationSnapshot(database, created.id)!;
		const interrupted = acceptGeneration(database, acceptedInput(interruptedBase, captured, "2026-09-23T00:06:00.000Z"), { kind: "send", expectedRevision: interruptedBase.revision, content: "Ask about the key." });
		checkpointFromStart(database, { conversationId: created.id, generationId: interrupted.generationId, content: "Retained partial output." });
		stopConversationGeneration(database, { cause: "user-stop", conversationId: created.id, generationId: interrupted.generationId });
		const interruptedTarget = readTestConversationSnapshot(database, created.id)!.messages.at(-1)!;
		expect(readVariantDetails(database, created.id, interruptedTarget.id, interruptedTarget.variants[0]!.id)?.boxTraces).toEqual(captured);

		const fresh = readTestConversationSnapshot(database, created.id)!;
		const empty = acceptGeneration(database, acceptedInput(fresh, captured, "2026-09-23T00:07:00.000Z"), { kind: "send", expectedRevision: fresh.revision, content: "Ask about the key." });
		stopConversationGeneration(database, { cause: "user-stop", conversationId: created.id, generationId: empty.generationId });
		expect(readTestConversationSnapshot(database, created.id)!.messages.some(({ id }) => id === empty.messageId)).toBe(false);
		expect(readVariantDetails(database, created.id, empty.messageId, empty.provisionalVariantId)).toBeUndefined();
		expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
	});

	test("reject generic writes to Box trace provenance and report corrupt active records", () => {
		const created = createChat(database);
		const source = created.messages[0]!;
		const captured = traces(source.id, source.variants[0]!.id);

		expect(() => executeConversationCommand(database, {
			conversationId: created.id,
			expectedRevision: created.revision,
			action: { type: "put-data", scope: { type: "conversation" }, namespace: "generation-box", key: "traces", value: "{}" },
		})).toThrow("server-owned provenance");
		const accepted = acceptGeneration(database, acceptedInput(created, captured), { kind: "send", expectedRevision: created.revision, content: "Ask about the key." });
		database.run("UPDATE active_generation SET box_traces_json = ? WHERE id = ?", [JSON.stringify({ "box:memory": { trace: {} } }), accepted.generationId]);
		expect(() => readActiveGenerationDetails(database, created.id, accepted.generationId)).toThrow("Persisted Box traces do not match their schema.");
	});
});
