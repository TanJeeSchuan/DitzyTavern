import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createConversationModule } from "../conversation";
import { createConversationRoutes } from "./conversation";
import type { MemoryActivationRecord } from "../../shared/contract/memory-recall";
import { generationJsonObject } from "../../shared/generation-provenance";

const prompt = {
	systemInstruction: "Answer briefly.",
	identity: "I am {{self}}.",
	scenario: "A quiet room.",
	exampleDialogue: "",
	postHistoryInstruction: "Continue.",
};

const activation = (
	messageId: number,
	variantId: number,
	finalMemoryText = "Maren still has the key.",
): MemoryActivationRecord => ({
	version: 1,
	state: "ready",
	allowance: 1024,
	eligibleSourceCount: 1,
	readyRecordCount: 1,
	embeddingModel: "test-embedding",
	embeddingDeadlineMs: 1000,
	decisionProfileName: null, decisionModel: "test-jev",
	decisionConfigured: true,
	relevanceMinimum: 1.5,
	pendingSourceCount: 0,
	pendingIndexCount: 0,
	failedIndexCount: 0,
	failedSourceCount: 0,
	sourceSnapshotFingerprint: "source-fingerprint",
	embeddingConfigurationFingerprint: "embedding-fingerprint",
	scanMessageIds: [messageId],
	scanTruncated: false,
	scene: "Maren asks for the key.",
	semanticShortlistCount: 1,
	recentShortlistCount: 1,
	candidates: [{
		identity: `${messageId}:${variantId}:1:1:0`,
		messageId,
		variantId,
		collectionRevision: 1,
		ownership: "automatic",
		sourceChanged: false,
		claimIndex: 0,
		claim: "Maren keeps the brass key.",
		attribution: "Narrated event",
		people: ["Maren"],
		evidence: [{ messageId, excerpt: "Maren kept the brass key." }],
		sourcePosition: 1,
		semanticSimilarity: 0.94,
		semanticRank: 1,
		recentRank: 1,
			relevance: "central",
		relevanceScore: 3,
				admission: "admitted",
	}],
	automaticMemoryText: "Maren keeps the brass key.",
	finalMemoryText,
	manuallyEdited: finalMemoryText !== "Maren keeps the brass key.",
});

const createChat = (database: Database) => {
	const module = createConversationModule(database);
	const created = module.create({
		name: "Memory evidence",
		participants: [
			{ definition: { name: "Writer", prompt, openings: [] } },
			{ definition: { name: "Maren", prompt, openings: [] } },
		],
		control: { human: 0, model: 1 },
	});
	module.execute({
		conversationId: created.id,
		expectedRevision: created.revision,
		action: { type: "create-message", timestamp: "2026-09-23T00:00:00.000Z", variantContents: ["Maren kept the brass key."], selectedVariantIndex: 0, authorParticipantId: created.cast[1]!.id },
	});
	return module.getSnapshot(created.id)!;
};

const acceptedInput = (conversation: ReturnType<typeof createChat>, memory: MemoryActivationRecord) => ({
	conversationId: conversation.id,
	expectedRevision: conversation.revision,
	timestamp: "2026-09-23T00:01:00.000Z",
	humanContent: "Ask about the key.",
	humanParticipantId: conversation.cast[0]!.id,
	modelParticipantId: conversation.cast[1]!.id,
	capturedHumanName: "Writer",
	capturedModelName: "Maren",
	promptPlan: { blocks: [{ kind: "memory" as const, role: "system" as const, content: memory.finalMemoryText }], warnings: [], images: [] },
	memoryActivation: memory,
	promptContext: [],
	generationSettings: {},
	connection: null,
});

describe("permanent Memory Activation Records", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("retain the exact attempt after source changes and replay expiry", async () => {
		const created = createChat(database);
		const source = created.messages[0]!;
		const sourceVariant = source.variants[0]!;
		const memory = activation(source.id, sourceVariant.id);
		const module = createConversationModule(database);
		const accepted = module.acceptTailGeneration(acceptedInput(created, memory));
		const app = createConversationRoutes(database);
		const inspected = await app.handle(new Request(`http://localhost/api/conversations/${created.id}/generations/${accepted.generationId}/inspection`));
		expect(inspected.status).toBe(200);
		const inspectedDetails = generationJsonObject(await inspected.json());
		expect(inspectedDetails?.memoryActivation).toEqual(memory);
		expect(inspectedDetails?.memorySources).toEqual({ messageIds: [source.id], variantIds: [sourceVariant.id] });

		module.resolveGeneration({ conversationId: created.id, generationId: accepted.generationId, timestamp: "2026-09-23T00:02:00.000Z", content: "Maren pockets the key." });
		const generated = module.getSnapshot(created.id)!.messages.at(-1)!;
		const generatedVariant = generated.variants.at(-1)!;
		expect(module.readVariantDetails(created.id, generated.id, generatedVariant.id)?.memoryActivation).toEqual(memory);

		const revision = module.getSnapshot(created.id)!.revision;
		module.execute({ conversationId: created.id, expectedRevision: revision, action: { type: "edit-variant", messageId: source.id, variantId: sourceVariant.id, content: "Maren returned the key." } });
		const afterEdit = module.readVariantDetails(created.id, generated.id, generatedVariant.id)!;
		expect(afterEdit.memoryActivation).toEqual(memory);
		expect(afterEdit.memorySources.variantIds).toContain(sourceVariant.id);

		const beforeDeleteRevision = module.getSnapshot(created.id)!.revision;
		module.execute({ conversationId: created.id, expectedRevision: beforeDeleteRevision, action: { type: "delete-message", messageId: source.id } });
		const afterDeletion = module.readVariantDetails(created.id, generated.id, generatedVariant.id)!;
		expect(afterDeletion.memoryActivation?.candidates[0]?.evidence[0]?.excerpt).toBe("Maren kept the brass key.");
		expect(afterDeletion.memorySources.variantIds).not.toContain(sourceVariant.id);

		database.run("UPDATE generation_replay SET expires_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", accepted.generationId]);
		const expiredInspection = await app.handle(new Request(`http://localhost/api/conversations/${created.id}/generations/${accepted.generationId}/inspection`));
		const historicalDetails = await app.handle(new Request(`http://localhost/api/conversations/${created.id}/messages/${generated.id}/variants/${generatedVariant.id}/details`));
		expect(expiredInspection.status).toBe(404);
		expect(historicalDetails.status).toBe(200);
		expect(await historicalDetails.json()).toMatchObject({ memoryActivation: memory });

		database.run("UPDATE message_variant_data SET value = ? WHERE message_variant_id = ? AND namespace = ? AND key = ?", ["{", generatedVariant.id, "generation-memory", "activation"]);
		const corruptDetails = await app.handle(new Request(`http://localhost/api/conversations/${created.id}/messages/${generated.id}/variants/${generatedVariant.id}/details`));
		expect(corruptDetails.status).toBe(422);
		expect(await corruptDetails.json()).toEqual({ outcome: "invalid", reason: "Persisted Memory Activation Record is not valid JSON." });

		database.run("UPDATE message_variant_data SET value = ? WHERE message_variant_id = ? AND namespace = ? AND key = ?", ["{}", generatedVariant.id, "generation-memory", "activation"]);
		const nullDetails = await app.handle(new Request(`http://localhost/api/conversations/${created.id}/messages/${generated.id}/variants/${generatedVariant.id}/details`));
		expect(nullDetails.status).toBe(422);
		expect(await nullDetails.json()).toEqual({ outcome: "invalid", reason: "Persisted Memory Activation Record does not match its schema." });
	});

	test("give each sibling its own record and keep interrupted output while removing empty targets", async () => {
		const created = createChat(database);
		const source = created.messages[0]!;
		const memory = activation(source.id, source.variants[0]!.id);
		const module = createConversationModule(database);
		const base = module.acceptTailGeneration(acceptedInput(created, memory));
		module.resolveGeneration({ conversationId: created.id, generationId: base.generationId, timestamp: "2026-09-23T00:02:00.000Z", content: "Maren pockets the key." });
		const model = created.cast[1]!;
		const human = created.cast[0]!;
		const baseMessage = module.getSnapshot(created.id)!.messages.at(-1)!;
		const siblingMemory = (finalMemoryText: string) => activation(source.id, source.variants[0]!.id, finalMemoryText);
		const acceptSibling = (record: MemoryActivationRecord) => module.acceptSiblingGeneration({
			conversationId: created.id,
			timestamp: "2026-09-23T00:03:00.000Z",
			messageId: baseMessage.id,
			humanParticipantId: human.id,
			modelParticipantId: model.id,
			capturedHumanName: human.name,
			capturedModelName: model.name,
			promptPlan: { blocks: [{ kind: "memory", role: "system", content: record.finalMemoryText }], warnings: [], images: [] },
			memoryActivation: record,
			promptContext: [],
			generationSettings: {},
			connection: null,
		});
		const firstMemory = siblingMemory("The first captured edit.");
		const first = acceptSibling(firstMemory);
		module.resolveGeneration({ conversationId: created.id, generationId: first.generationId, timestamp: "2026-09-23T00:04:00.000Z", content: "First alternative." });
		const secondMemory = siblingMemory("The second captured edit.");
		const second = acceptSibling(secondMemory);
		module.resolveGeneration({ conversationId: created.id, generationId: second.generationId, timestamp: "2026-09-23T00:05:00.000Z", content: "Second alternative." });
		expect(module.readVariantDetails(created.id, baseMessage.id, first.provisionalVariantId)?.memoryActivation).toEqual(firstMemory);
		expect(module.readVariantDetails(created.id, baseMessage.id, second.provisionalVariantId)?.memoryActivation).toEqual(secondMemory);
		const revision = module.getSnapshot(created.id)!.revision;
		module.execute({ conversationId: created.id, expectedRevision: revision, action: { type: "delete-variant", messageId: baseMessage.id, variantId: first.provisionalVariantId } });
		expect(module.readVariantDetails(created.id, baseMessage.id, first.provisionalVariantId)).toBeUndefined();
		expect(module.readVariantDetails(created.id, baseMessage.id, second.provisionalVariantId)?.memoryActivation).toEqual(secondMemory);
		expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
		const deletedVariantDetails = await createConversationRoutes(database).handle(new Request(`http://localhost/api/conversations/${created.id}/messages/${baseMessage.id}/variants/${first.provisionalVariantId}/details`));
		expect(deletedVariantDetails.status).toBe(404);

		const interruptedBase = module.getSnapshot(created.id)!;
		const interrupted = module.acceptTailGeneration({ ...acceptedInput(interruptedBase, memory), expectedRevision: interruptedBase.revision, timestamp: "2026-09-23T00:06:00.000Z" });
		module.checkpointGeneration({ conversationId: created.id, generationId: interrupted.generationId, content: "Retained partial output." });
		module.stopGeneration({ conversationId: created.id, generationId: interrupted.generationId });
		const interruptedTarget = module.getSnapshot(created.id)!.messages.at(-1)!;
		expect(module.readVariantDetails(created.id, interruptedTarget.id, interruptedTarget.variants[0]!.id)?.memoryActivation).toEqual(memory);

		const fresh = module.getSnapshot(created.id)!;
		const empty = module.acceptTailGeneration({ ...acceptedInput(fresh, memory), expectedRevision: fresh.revision, timestamp: "2026-09-23T00:07:00.000Z" });
		module.stopGeneration({ conversationId: created.id, generationId: empty.generationId });
		expect(module.getSnapshot(created.id)!.messages.some(({ id }) => id === empty.messageId)).toBe(false);
		expect(module.readVariantDetails(created.id, empty.messageId, empty.provisionalVariantId)).toBeUndefined();
		expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
	});

	test("reject generic writes to Memory provenance and report corrupt active records", async () => {
		const created = createChat(database);
		const source = created.messages[0]!;
		const memory = activation(source.id, source.variants[0]!.id);
		const module = createConversationModule(database);
		expect(() => module.execute({
			conversationId: created.id,
			expectedRevision: created.revision,
			action: { type: "put-data", scope: { type: "conversation" }, namespace: "generation-memory", key: "activation", value: "{}" },
		})).toThrow("server-owned provenance");
		const accepted = module.acceptTailGeneration(acceptedInput(created, memory));
		database.run("UPDATE active_generation SET memory_activation_json = ? WHERE id = ?", [JSON.stringify({ version: 1 }), accepted.generationId]);
		const inspection = await createConversationRoutes(database).handle(new Request(`http://localhost/api/conversations/${created.id}/generations/${accepted.generationId}/inspection`));
		expect(inspection.status).toBe(422);
		expect(await inspection.json()).toEqual({ outcome: "invalid", reason: "Persisted Memory Activation Record does not match its schema." });
	});
});
