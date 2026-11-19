import { readTestConversationSnapshot, checkpointFromStart, shortReplyPrompt, pairChat, acceptTestGeneration } from "../test-fixtures/conversation";
import { resolveConversationGeneration, readActiveGenerationDetails, readVariantDetails, executeConversationCommand, stopConversationGeneration } from ".";
import { openObservedDatabase } from "../test-fixtures/conversation";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

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

	test("are copied to Variant data and remain readable after replay expiry", () => {
		const created = pairChat(database, "Lore details", { prompt });

		const accepted = acceptTestGeneration(database, created, { kind: "send", expectedRevision: created.revision, content: "Mention the tower." }, {
			timestamp: "2026-09-17T10:00:00Z",
			loreActivation: evidence,
		});
		resolveConversationGeneration(database, {
			conversationId: created.id,
			generationId: accepted.generationId,
			timestamp: "2026-09-17T10:00:01Z",
			content: "The tower appeared.",
		});
		const message = readTestConversationSnapshot(database, created.id)!.messages.at(-1)!;
		const variant = message.variants.at(-1)!;
		expect(readVariantDetails(database, created.id, message.id, variant.id)?.loreActivation).toEqual(evidence);
		database.run("UPDATE generation_replay SET expires_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", accepted.generationId]);
		expect(readActiveGenerationDetails(database, created.id, accepted.generationId)).toBeUndefined();
		expect(readVariantDetails(database, created.id, message.id, variant.id)?.loreActivation).toEqual(evidence);
	});

	test("rejects generic writes to the server-owned namespace", () => {
		const created = pairChat(database, "Lore namespace", { prompt });

		expect(() => executeConversationCommand(database, {
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

	test("rejects corrupt active and persisted Lore Activation Records", () => {
		const created = pairChat(database, "Corrupt lore details", { prompt });

		const accepted = acceptTestGeneration(database, created, { kind: "send", expectedRevision: created.revision, content: "Mention the tower." }, {
			timestamp: "2026-09-17T10:00:00Z",
			loreActivation: evidence,
		});
		database.run("UPDATE active_generation SET lore_activation_json = ? WHERE id = ?", ["{", accepted.generationId]);
		expect(() => readActiveGenerationDetails(database, created.id, accepted.generationId)).toThrow("Persisted Lore Activation Record is not valid JSON.");

		database.run("UPDATE active_generation SET lore_activation_json = ? WHERE id = ?", [JSON.stringify(evidence), accepted.generationId]);
		resolveConversationGeneration(database, {
			conversationId: created.id,
			generationId: accepted.generationId,
			timestamp: "2026-09-17T10:00:01Z",
			content: "The tower appeared.",
		});
		const message = readTestConversationSnapshot(database, created.id)!.messages.at(-1)!;
		const variant = message.variants.at(-1)!;
		database.run(
			"UPDATE message_variant_data SET value = ? WHERE message_variant_id = ? AND namespace = ? AND key = ?",
			["{\"version\":1}", variant.id, "lore-activation", "record"],
		);
		expect(() => readVariantDetails(database, created.id, message.id, variant.id)).toThrow("Persisted Lore Activation Record does not match the canonical schema.");
	});

	test("retains evidence on interrupted output but cleans it up with zero-output targets", () => {
		const created = pairChat(database, "Interrupted lore", { prompt });

		const accepted = acceptTestGeneration(database, created, { kind: "send", expectedRevision: created.revision, content: "Mention the tower." }, {
			timestamp: "2026-09-17T10:00:00Z",
			loreActivation: evidence,
		});
		checkpointFromStart(database, {
			conversationId: created.id,
			generationId: accepted.generationId,
			content: "The tower appeared.",
		});
		stopConversationGeneration(database, { cause: "user-stop", conversationId: created.id, generationId: accepted.generationId });
		const interrupted = readTestConversationSnapshot(database, created.id)!.messages.at(-1)!;
		const interruptedVariant = interrupted.variants.at(-1)!;
		expect(readVariantDetails(database, created.id, interrupted.id, interruptedVariant.id)?.loreActivation).toEqual(evidence);

		const fresh = readTestConversationSnapshot(database, created.id)!;
		const zeroOutput = acceptTestGeneration(database, created, { kind: "send", expectedRevision: fresh.revision, content: "Try again." }, {
			timestamp: "2026-09-17T10:00:02Z",
			loreActivation: evidence,
		});
		stopConversationGeneration(database, { cause: "user-stop", conversationId: created.id, generationId: zeroOutput.generationId });
		const afterCleanup = readTestConversationSnapshot(database, created.id)!;
		expect(afterCleanup.messages.at(-1)?.variants.at(-1)?.data).not.toContainEqual({
			namespace: "lore-activation",
			key: "record",
			value: JSON.stringify(evidence),
		});
	});
});
