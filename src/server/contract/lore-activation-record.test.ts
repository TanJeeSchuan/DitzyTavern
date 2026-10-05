import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createConversationModule } from "../conversation";
import { createConversationRoutes } from "./conversation";

const prompt = {
	systemInstruction: "Answer briefly.",
	identity: "I am {{self}}.",
	scenario: "A quiet room.",
	exampleDialogue: "",
	postHistoryInstruction: "Continue.",
};

const evidence = {
	version: 1 as const,
	mode: "keyword-fallback" as const,
	evidence: {
		books: [{ bookId: 7, name: "Setting", eligible: true }],
		entries: [{ entryId: 9, content: "The old tower." , admitted: true }],
	},
	automaticLoreText: "The old tower.",
	finalLoreText: "The old tower.",
	manuallyEdited: false,
};

describe("permanent Lore Activation Records", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("are copied to Variant data and remain readable after replay expiry", async () => {
		const created = createConversationModule(database).create({
			name: "Lore details",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		const module = createConversationModule(database);
		const accepted = module.acceptTailGeneration({
			conversationId: created.id,
			expectedRevision: created.revision,
			timestamp: "2026-09-17T10:00:00Z",
			humanContent: "Mention the tower.",
			humanParticipantId: created.cast[0]!.id,
			modelParticipantId: created.cast[1]!.id,
			capturedHumanName: "Writer",
			capturedModelName: "Maren",
			promptPlan: { blocks: [], warnings: [], sendImages: true, images: [] },
			promptContext: [],
			generationSettings: {},
			connection: null,
			loreActivation: evidence,
		});
		module.resolveGeneration({
			conversationId: created.id,
			generationId: accepted.generationId,
			timestamp: "2026-09-17T10:00:01Z",
			content: "The tower appeared.",
		});
		const message = module.getSnapshot(created.id)!.messages.at(-1)!;
		const variant = message.variants.at(-1)!;
		expect(module.readVariantDetails(created.id, message.id, variant.id)?.loreActivation).toEqual(evidence);

		const response = await createConversationRoutes(database).handle(new Request(
			`http://localhost/api/conversations/${created.id}/messages/${message.id}/variants/${variant.id}/details`,
		));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ loreActivation: evidence });
	});

	test("rejects generic writes to the server-owned namespace", () => {
		const created = createConversationModule(database).create({
			name: "Lore namespace",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		const module = createConversationModule(database);
		expect(() => module.execute({
			conversationId: created.id,
			expectedRevision: created.revision,
			action: {
				type: "put-data",
				scope: { type: "conversation" },
				namespace: "lore-activation",
				key: "record",
				value: "{}",
			},
		})).toThrow("server-owned provenance");
	});

	test("reports corrupt persisted records through detail contracts", async () => {
		const created = createConversationModule(database).create({
			name: "Corrupt lore details",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		const module = createConversationModule(database);
		const accepted = module.acceptTailGeneration({
			conversationId: created.id,
			expectedRevision: created.revision,
			timestamp: "2026-09-17T10:00:00Z",
			humanContent: "Mention the tower.",
			humanParticipantId: created.cast[0]!.id,
			modelParticipantId: created.cast[1]!.id,
			capturedHumanName: "Writer",
			capturedModelName: "Maren",
			promptPlan: { blocks: [], warnings: [], sendImages: true, images: [] },
			promptContext: [],
			generationSettings: {},
			connection: null,
			loreActivation: evidence,
		});
		database.run("UPDATE active_generation SET lore_activation_json = ? WHERE id = ?", ["{", accepted.generationId]);
		const app = createConversationRoutes(database);
		const inspection = await app.handle(new Request(
			`http://localhost/api/conversations/${created.id}/generations/${accepted.generationId}/inspection`,
		));
		expect(inspection.status).toBe(422);
		expect(await inspection.json()).toEqual({
			outcome: "invalid",
			reason: "Persisted Lore Activation Record is not valid JSON.",
		});

		database.run("UPDATE active_generation SET lore_activation_json = ? WHERE id = ?", [JSON.stringify(evidence), accepted.generationId]);
		module.resolveGeneration({
			conversationId: created.id,
			generationId: accepted.generationId,
			timestamp: "2026-09-17T10:00:01Z",
			content: "The tower appeared.",
		});
		const message = module.getSnapshot(created.id)!.messages.at(-1)!;
		const variant = message.variants.at(-1)!;
		database.run(
			"UPDATE message_variant_data SET value = ? WHERE message_variant_id = ? AND namespace = ? AND key = ?",
			["{\"version\":1}", variant.id, "lore-activation", "record"],
		);
		const details = await app.handle(new Request(
			`http://localhost/api/conversations/${created.id}/messages/${message.id}/variants/${variant.id}/details`,
		));
		expect(details.status).toBe(422);
		expect(await details.json()).toEqual({
			outcome: "invalid",
			reason: "Persisted Lore Activation Record does not match the canonical schema.",
		});
	});

	test("retains evidence on interrupted output but cleans it up with zero-output targets", () => {
		const created = createConversationModule(database).create({
			name: "Interrupted lore",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		const module = createConversationModule(database);
		const human = created.cast[0];
		const model = created.cast[1];
		if (human === undefined || model === undefined) throw new Error("Control Participants missing.");
		const accepted = module.acceptTailGeneration({
			conversationId: created.id,
			expectedRevision: created.revision,
			timestamp: "2026-09-17T10:00:00Z",
			humanContent: "Mention the tower.",
			humanParticipantId: human.id,
			modelParticipantId: model.id,
			capturedHumanName: human.name,
			capturedModelName: model.name,
			promptPlan: { blocks: [], warnings: [], sendImages: true, images: [] },
			promptContext: [],
			generationSettings: {},
			connection: null,
			loreActivation: evidence,
		});
		module.checkpointGeneration({
			conversationId: created.id,
			generationId: accepted.generationId,
			content: "The tower appeared.",
		});
		module.stopGeneration({ conversationId: created.id, generationId: accepted.generationId });
		const interrupted = module.getSnapshot(created.id)!.messages.at(-1)!;
		const interruptedVariant = interrupted.variants.at(-1)!;
		expect(module.readVariantDetails(created.id, interrupted.id, interruptedVariant.id)?.loreActivation).toEqual(evidence);

		const fresh = module.getSnapshot(created.id)!;
		const zeroOutput = module.acceptTailGeneration({
			conversationId: created.id,
			expectedRevision: fresh.revision,
			timestamp: "2026-09-17T10:00:02Z",
			humanContent: "Try again.",
			humanParticipantId: human.id,
			modelParticipantId: model.id,
			capturedHumanName: human.name,
			capturedModelName: model.name,
			promptPlan: { blocks: [], warnings: [], sendImages: true, images: [] },
			promptContext: [],
			generationSettings: {},
			connection: null,
			loreActivation: evidence,
		});
		module.stopGeneration({ conversationId: created.id, generationId: zeroOutput.generationId });
		const afterCleanup = module.getSnapshot(created.id)!;
		expect(afterCleanup.messages.at(-1)?.variants.at(-1)?.data).not.toContainEqual({
			namespace: "lore-activation",
			key: "record",
			value: JSON.stringify(evidence),
		});
	});
});
