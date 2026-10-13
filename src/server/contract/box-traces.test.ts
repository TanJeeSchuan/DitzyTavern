import { readTestConversationSnapshot, createConversationWithHistory } from "../test-fixtures/conversation";
import {
	executeConversationCommand,
	acceptConversationTailGeneration,
	resolveConversationGeneration,
	readVariantDetails,
	acceptConversationSiblingGeneration,
	checkpointConversationGeneration,
	stopConversationGeneration,
} from "../conversation";
import { openObservedDatabase } from "../test-fixtures/conversation";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createConversationRoutes } from "./conversation";
import type { BoxTraces } from "../../shared/contract/box-generation";
import { generationJsonObject } from "../../shared/generation-provenance";

const prompt = {
	systemInstruction: "Answer briefly.",
	identity: "I am {{self}}.",
	scenario: "A quiet room.",
	exampleDialogue: "",
	postHistoryInstruction: "Continue.",
};

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
	const module = database;
	const created = createConversationWithHistory(module, {
		name: "Box traces",
		participants: [
			{ definition: { name: "Writer", prompt, openings: [] } },
			{ definition: { name: "Maren", prompt, openings: [] } },
		],
		control: { human: 0, model: 1 },
	});
	executeConversationCommand(module, {
		conversationId: created.id,
		expectedRevision: created.revision,
		action: { type: "create-message", timestamp: "2026-09-23T00:00:00.000Z", variantContents: ["Maren kept the brass key."], selectedVariantIndex: 0, authorParticipantId: created.cast[1]!.id },
	});
	return readTestConversationSnapshot(module, created.id)!;
};

const acceptedInput = (conversation: ReturnType<typeof createChat>, boxTraces: BoxTraces) => ({
	seed: "test-generation-seed",
	conversationId: conversation.id,
	expectedRevision: conversation.revision,
	timestamp: "2026-09-23T00:01:00.000Z",
	humanContent: "Ask about the key.",
	humanParticipantId: conversation.cast[0]!.id,
	modelParticipantId: conversation.cast[1]!.id,
	capturedHumanName: "Writer",
	capturedModelName: "Maren",
	promptPlan: { blocks: [{ kind: "box:memory" as const, role: "system" as const, content: boxTraces["box:memory"]!.finalText }], warnings: [], images: [] },
	boxTraces,
	promptContext: [],
	generationSettings: {},
	connection: null,
});

describe("permanent Box traces", () => {
	let database: Database;

	beforeEach(() => {
		database = openObservedDatabase();
	});
	afterEach(() => database.close());

	test("retain the exact attempt after source changes and replay expiry", async () => {
		const created = createChat(database);
		const source = created.messages[0]!;
		const sourceVariant = source.variants[0]!;
		const captured = traces(source.id, sourceVariant.id);
		const module = database;
		const accepted = acceptConversationTailGeneration(module, acceptedInput(created, captured));
		const app = createConversationRoutes(database);
		const inspected = await app.handle(new Request(`http://localhost/api/conversations/${created.id}/generations/${accepted.generationId}/inspection`));
		expect(inspected.status).toBe(200);
		const inspectedDetails = generationJsonObject(await inspected.json());
		expect(inspectedDetails?.boxTraces).toEqual(captured);

		resolveConversationGeneration(module, { conversationId: created.id, generationId: accepted.generationId, timestamp: "2026-09-23T00:02:00.000Z", content: "Maren pockets the key." });
		const generated = readTestConversationSnapshot(module, created.id)!.messages.at(-1)!;
		const generatedVariant = generated.variants.at(-1)!;
		expect(readVariantDetails(module, created.id, generated.id, generatedVariant.id)?.boxTraces).toEqual(captured);

		const revision = readTestConversationSnapshot(module, created.id)!.revision;
		executeConversationCommand(module, { conversationId: created.id, expectedRevision: revision, action: { type: "edit-variant", messageId: source.id, variantId: sourceVariant.id, content: "Maren returned the key." } });
		const afterEdit = readVariantDetails(module, created.id, generated.id, generatedVariant.id)!;
		expect(afterEdit.boxTraces).toEqual(captured);

		const beforeDeleteRevision = readTestConversationSnapshot(module, created.id)!.revision;
		executeConversationCommand(module, { conversationId: created.id, expectedRevision: beforeDeleteRevision, action: { type: "delete-message", messageId: source.id } });
		const afterDeletion = readVariantDetails(module, created.id, generated.id, generatedVariant.id)!;
		expect(afterDeletion.boxTraces).toEqual(captured);

		database.run("UPDATE generation_replay SET expires_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", accepted.generationId]);
		const expiredInspection = await app.handle(new Request(`http://localhost/api/conversations/${created.id}/generations/${accepted.generationId}/inspection`));
		const historicalDetails = await app.handle(new Request(`http://localhost/api/conversations/${created.id}/messages/${generated.id}/variants/${generatedVariant.id}/details`));
		expect(expiredInspection.status).toBe(404);
		expect(historicalDetails.status).toBe(200);
		expect(await historicalDetails.json()).toMatchObject({ boxTraces: captured });

		database.run("UPDATE message_variant_data SET value = ? WHERE message_variant_id = ? AND namespace = ? AND key = ?", ["{", generatedVariant.id, "generation-box", "traces"]);
		const corruptDetails = await app.handle(new Request(`http://localhost/api/conversations/${created.id}/messages/${generated.id}/variants/${generatedVariant.id}/details`));
		expect(corruptDetails.status).toBe(422);
		expect(await corruptDetails.json()).toEqual({ outcome: "invalid", reason: "Persisted Box traces are not valid JSON." });

		database.run("UPDATE message_variant_data SET value = ? WHERE message_variant_id = ? AND namespace = ? AND key = ?", ["[]", generatedVariant.id, "generation-box", "traces"]);
		const nullDetails = await app.handle(new Request(`http://localhost/api/conversations/${created.id}/messages/${generated.id}/variants/${generatedVariant.id}/details`));
		expect(nullDetails.status).toBe(422);
		expect(await nullDetails.json()).toEqual({ outcome: "invalid", reason: "Persisted Box traces do not match their schema." });
	});

	test("give each sibling its own record and keep interrupted output while removing empty targets", async () => {
		const created = createChat(database);
		const source = created.messages[0]!;
		const captured = traces(source.id, source.variants[0]!.id);
		const module = database;
		const base = acceptConversationTailGeneration(module, acceptedInput(created, captured));
		resolveConversationGeneration(module, { conversationId: created.id, generationId: base.generationId, timestamp: "2026-09-23T00:02:00.000Z", content: "Maren pockets the key." });
		const model = created.cast[1]!;
		const human = created.cast[0]!;
		const baseMessage = readTestConversationSnapshot(module, created.id)!.messages.at(-1)!;
		const siblingTraces = (finalText: string) => traces(source.id, source.variants[0]!.id, finalText);
		const acceptSibling = (record: BoxTraces) => acceptConversationSiblingGeneration(module, {
			seed: "test-generation-seed",
			conversationId: created.id,
			timestamp: "2026-09-23T00:03:00.000Z",
			messageId: baseMessage.id,
			humanParticipantId: human.id,
			modelParticipantId: model.id,
			capturedHumanName: human.name,
			capturedModelName: model.name,
			promptPlan: { blocks: [{ kind: "box:memory", role: "system", content: record["box:memory"]!.finalText }], warnings: [], images: [] },
			boxTraces: record,
			promptContext: [],
			generationSettings: {},
			connection: null,
		});
		const firstTraces = siblingTraces("The first captured edit.");
		const first = acceptSibling(firstTraces);
		resolveConversationGeneration(module, { conversationId: created.id, generationId: first.generationId, timestamp: "2026-09-23T00:04:00.000Z", content: "First alternative." });
		const secondTraces = siblingTraces("The second captured edit.");
		const second = acceptSibling(secondTraces);
		resolveConversationGeneration(module, { conversationId: created.id, generationId: second.generationId, timestamp: "2026-09-23T00:05:00.000Z", content: "Second alternative." });
		expect(readVariantDetails(module, created.id, baseMessage.id, first.provisionalVariantId)?.boxTraces).toEqual(firstTraces);
		expect(readVariantDetails(module, created.id, baseMessage.id, second.provisionalVariantId)?.boxTraces).toEqual(secondTraces);
		const revision = readTestConversationSnapshot(module, created.id)!.revision;
		executeConversationCommand(module, { conversationId: created.id, expectedRevision: revision, action: { type: "delete-variant", messageId: baseMessage.id, variantId: first.provisionalVariantId } });
		expect(readVariantDetails(module, created.id, baseMessage.id, first.provisionalVariantId)).toBeUndefined();
		expect(readVariantDetails(module, created.id, baseMessage.id, second.provisionalVariantId)?.boxTraces).toEqual(secondTraces);
		expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
		const deletedVariantDetails = await createConversationRoutes(database).handle(new Request(`http://localhost/api/conversations/${created.id}/messages/${baseMessage.id}/variants/${first.provisionalVariantId}/details`));
		expect(deletedVariantDetails.status).toBe(404);

		const interruptedBase = readTestConversationSnapshot(module, created.id)!;
		const interrupted = acceptConversationTailGeneration(module, { ...acceptedInput(interruptedBase, captured), expectedRevision: interruptedBase.revision, timestamp: "2026-09-23T00:06:00.000Z" });
		checkpointConversationGeneration(module, { conversationId: created.id, generationId: interrupted.generationId, content: "Retained partial output." });
		stopConversationGeneration(module, { conversationId: created.id, generationId: interrupted.generationId });
		const interruptedTarget = readTestConversationSnapshot(module, created.id)!.messages.at(-1)!;
		expect(readVariantDetails(module, created.id, interruptedTarget.id, interruptedTarget.variants[0]!.id)?.boxTraces).toEqual(captured);

		const fresh = readTestConversationSnapshot(module, created.id)!;
		const empty = acceptConversationTailGeneration(module, { ...acceptedInput(fresh, captured), expectedRevision: fresh.revision, timestamp: "2026-09-23T00:07:00.000Z" });
		stopConversationGeneration(module, { conversationId: created.id, generationId: empty.generationId });
		expect(readTestConversationSnapshot(module, created.id)!.messages.some(({ id }) => id === empty.messageId)).toBe(false);
		expect(readVariantDetails(module, created.id, empty.messageId, empty.provisionalVariantId)).toBeUndefined();
		expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
	});

	test("reject generic writes to Box trace provenance and report corrupt active records", async () => {
		const created = createChat(database);
		const source = created.messages[0]!;
		const captured = traces(source.id, source.variants[0]!.id);
		const module = database;
		expect(() => executeConversationCommand(module, {
			conversationId: created.id,
			expectedRevision: created.revision,
			action: { type: "put-data", scope: { type: "conversation" }, namespace: "generation-box", key: "traces", value: "{}" },
		})).toThrow("server-owned provenance");
		const accepted = acceptConversationTailGeneration(module, acceptedInput(created, captured));
		database.run("UPDATE active_generation SET box_traces_json = ? WHERE id = ?", [JSON.stringify({ "box:memory": { trace: {} } }), accepted.generationId]);
		const inspection = await createConversationRoutes(database).handle(new Request(`http://localhost/api/conversations/${created.id}/generations/${accepted.generationId}/inspection`));
		expect(inspection.status).toBe(422);
		expect(await inspection.json()).toEqual({ outcome: "invalid", reason: "Persisted Box traces do not match their schema." });
	});
});
