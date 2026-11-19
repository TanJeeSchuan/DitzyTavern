import { readTestConversationSnapshot, checkpointFromStart, shortReplyPrompt, pairChat, acceptTestGeneration } from "../test-fixtures/conversation";
import { resolveConversationGeneration, readVariantDetails, executeConversationCommand, stopConversationGeneration } from "../conversation";
import { openObservedDatabase } from "../test-fixtures/conversation";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createConversationRoutes } from "./conversation";

const prompt = shortReplyPrompt({ scenario: "A quiet room." });

const evidence = {
	version: 1 as const,
	mode: "keyword-fallback" as const,
	scan: [],
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

	beforeEach(() => {
		database = openObservedDatabase();
	});
	afterEach(() => database.close());

	test("are copied to Variant data and remain readable after replay expiry", async () => {
		const created = pairChat(database, "Lore details", { prompt });
		const module = database;
		const accepted = acceptTestGeneration(module, created, { kind: "send", expectedRevision: created.revision, content: "Mention the tower." }, {
			timestamp: "2026-09-17T10:00:00Z",
			loreActivation: evidence,
		});
		resolveConversationGeneration(module, {
			conversationId: created.id,
			generationId: accepted.generationId,
			timestamp: "2026-09-17T10:00:01Z",
			content: "The tower appeared.",
		});
		const message = readTestConversationSnapshot(module, created.id)!.messages.at(-1)!;
		const variant = message.variants.at(-1)!;
		expect(readVariantDetails(module, created.id, message.id, variant.id)?.loreActivation).toEqual(evidence);

		const response = await createConversationRoutes(database).handle(new Request(
			`http://localhost/api/conversations/${created.id}/messages/${message.id}/variants/${variant.id}/details`,
		));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ loreActivation: evidence });
	});

	test("rejects generic writes to the server-owned namespace", () => {
		const created = pairChat(database, "Lore namespace", { prompt });
		const module = database;
		expect(() => executeConversationCommand(module, {
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
		const created = pairChat(database, "Corrupt lore details", { prompt });
		const module = database;
		const accepted = acceptTestGeneration(module, created, { kind: "send", expectedRevision: created.revision, content: "Mention the tower." }, {
			timestamp: "2026-09-17T10:00:00Z",
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
		resolveConversationGeneration(module, {
			conversationId: created.id,
			generationId: accepted.generationId,
			timestamp: "2026-09-17T10:00:01Z",
			content: "The tower appeared.",
		});
		const message = readTestConversationSnapshot(module, created.id)!.messages.at(-1)!;
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
		const created = pairChat(database, "Interrupted lore", { prompt });
		const module = database;
		const human = created.cast[0];
		const model = created.cast[1];
		if (human === undefined || model === undefined) throw new Error("Control Participants missing.");
		const accepted = acceptTestGeneration(module, created, { kind: "send", expectedRevision: created.revision, content: "Mention the tower." }, {
			timestamp: "2026-09-17T10:00:00Z",
			loreActivation: evidence,
		});
		checkpointFromStart(module, {
			conversationId: created.id,
			generationId: accepted.generationId,
			content: "The tower appeared.",
		});
		stopConversationGeneration(module, { cause: "user-stop", conversationId: created.id, generationId: accepted.generationId });
		const interrupted = readTestConversationSnapshot(module, created.id)!.messages.at(-1)!;
		const interruptedVariant = interrupted.variants.at(-1)!;
		expect(readVariantDetails(module, created.id, interrupted.id, interruptedVariant.id)?.loreActivation).toEqual(evidence);

		const fresh = readTestConversationSnapshot(module, created.id)!;
		const zeroOutput = acceptTestGeneration(module, created, { kind: "send", expectedRevision: fresh.revision, content: "Try again." }, {
			timestamp: "2026-09-17T10:00:02Z",
			loreActivation: evidence,
		});
		stopConversationGeneration(module, { cause: "user-stop", conversationId: created.id, generationId: zeroOutput.generationId });
		const afterCleanup = readTestConversationSnapshot(module, created.id)!;
		expect(afterCleanup.messages.at(-1)?.variants.at(-1)?.data).not.toContainEqual({
			namespace: "lore-activation",
			key: "record",
			value: JSON.stringify(evidence),
		});
	});
});
