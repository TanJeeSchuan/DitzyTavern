import { boxDescriptor } from "../../shared/contract/box";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { readParticipants } from "@/box-sdk/server";
import { openInitializedDatabase } from "../../server/database/database";
import { createConversationWithHistory } from "../../server/test-fixtures/conversation";
import { emptyPromptChannels } from "../../shared/definition";
import { messageTable, messageVariantDataTable, messageVariantTable } from "../../server/database/schema";
import { sha256 } from "../../server/hash";
import { recordKey, writeAutomaticRecord, writeWriterRecord } from "../../server/box/records";
import { readBoxLifecycles } from "../../server/box/setup";
import { boxExports } from "../../server/box/exports";
import { memoryRoutes } from "./server-routes";
import { readMemoryLabelState } from "./server-chat";
import type { MemoryCandidateJudgment, MemoryIdentity, MemoryIdentityCommand, MemoryLabelMergeCommand } from "./contract";

const createChat = (database: Database) => createConversationWithHistory(database, {
	name: "Memory Exports",
	participants: ["Writer", "Alice"].map((name) => ({
		definition: { name, prompt: emptyPromptChannels(), sendAppearanceImages: true, openings: [] },
	})),
	control: { human: 0, model: 1 },
});

const timestamp = "2026-09-29T00:00:00Z";
/** One Claim as the Exports answer it: the stored claim beside the Message that holds it. */
const claimOf = (messageId: number, people: string[], claim = "Alice promised Bob a key.") => ({
	messageId, claim, attribution: "Alice said it.", people, evidence: [{ messageId, excerpt: "I promised Bob a key." }],
});
const candidate = (messageId: number, people: string[], claim?: string): MemoryCandidateJudgment => ({
	...claimOf(messageId, people, claim), judgment: { support: "supported", attribution: "correct", usefulness: "retain", probabilities: {}, confidence: { support: 1, attribution: 1, usefulness: 1 } },
});

const addMessage = (database: Database, conversationId: number, position: number, author?: { id: number; name: string }) =>
	drizzle(database).insert(messageTable).values({
		conversation_id: conversationId, position, timestamp, author_name: author?.name ?? null, author_participant_id: author?.id ?? null,
	}).returning().get().id;

const addVariant = (database: Database, conversationId: number, messageId: number, people: string[], selected = true, variantPosition = 0) => {
	const db = drizzle(database);
	const variant = db.insert(messageVariantTable).values({ message_id: messageId, position: variantPosition, timestamp, content: "I promised Bob a key.", selected }).returning().get();
	writeAutomaticRecord(db, boxDescriptor("memory"), readBoxLifecycles(db, conversationId).memory!.instance, variant.id, { claims: [candidate(messageId, people)] }, sha256(variant.content));
	return variant.id;
};

/** One Cast-label command body as its route takes it. */
const command = (database: Database, conversationId: number, request:
	| { path: "merge-labels"; body: MemoryLabelMergeCommand }
	| { path: "identity"; body: MemoryIdentityCommand }) =>
	memoryRoutes(database).handle(new Request(`http://localhost/conversations/${conversationId}/memories/${request.path}`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request.body),
	}));
const merge = (database: Database, conversationId: number, labels: string[], destination: string) =>
	command(database, conversationId, {
		path: "merge-labels", body: { labels, destination, expectedRevision: readMemoryLabelState(database, conversationId).revision },
	});
const setIdentity = (database: Database, conversationId: number, participantId: number, identity: MemoryIdentity) =>
	command(database, conversationId, {
		path: "identity", body: { expectedRevision: readMemoryLabelState(database, conversationId).revision, participantId, identity },
	});

/** The Chat's second Cast member, the one the human does not play. */
const otherParticipant = (database: Database, conversationId: number) => {
	const [, other] = readParticipants(database, conversationId);
	if (other === undefined) throw new Error("The Chat's second Participant is missing.");
	return other;
};

/** The Chat's Memory Exports, refusing a Chat that lost them. */
const exportsOf = (database: Database, conversationId: number) => {
	const { people, selectedClaims } = boxExports(database, conversationId).memory ?? {};
	if (people === undefined || selectedClaims === undefined) throw new Error("Memory's Exports are missing.");
	return { people, selectedClaims };
};

describe("Memory's Exports", () => {
	let database: Database;
	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("Exports resolve people and Claims on the Selected narrative path after label merges", async () => {
		const chat = createChat(database);
		const first = addMessage(database, chat.id, 1);
		addVariant(database, chat.id, first, ["Bob"]);
		const second = addMessage(database, chat.id, 2);
		addVariant(database, chat.id, second, ["Bob", "Alice"]);
		expect((await merge(database, chat.id, ["Bob"], "Bartholomew Crane")).status).toBe(200);
		const memory = exportsOf(database, chat.id);
		expect(memory.people()).toEqual(["Bartholomew Crane", "Alice"]);
		expect(memory.selectedClaims()).toEqual([
			claimOf(first, ["Bartholomew Crane"]),
			claimOf(second, ["Bartholomew Crane", "Alice"]),
		]);
	});

	test("a Writer override's Claims are the ones an Export answers with", () => {
		const chat = createChat(database);
		const message = addMessage(database, chat.id, 1);
		const variant = addVariant(database, chat.id, message, ["Maren"]);
		writeWriterRecord(drizzle(database), boxDescriptor("memory"), readBoxLifecycles(drizzle(database), chat.id).memory!.instance, variant,
			{ claims: [candidate(message, ["Maren"], "Maren kept the key.")] });
		const memory = exportsOf(database, chat.id);
		expect(memory.people()).toEqual(["Maren"]);
		expect(memory.selectedClaims()).toEqual([claimOf(message, ["Maren"], "Maren kept the key.")]);
	});

	test("Claims on a swiped-away Variant are left out", () => {
		const chat = createChat(database);
		const message = addMessage(database, chat.id, 1);
		addVariant(database, chat.id, message, ["Bob"], true, 0);
		addVariant(database, chat.id, message, ["Eve"], false, 1);
		const memory = exportsOf(database, chat.id);
		expect(memory.people()).toEqual(["Bob"]);
		expect(memory.selectedClaims()).toEqual([claimOf(message, ["Bob"])]);
	});

	test("both Exports skip an incompatible slot on an unselected Variant", () => {
		const chat = createChat(database);
		const message = addMessage(database, chat.id, 1);
		addVariant(database, chat.id, message, ["Bob"]);
		const sibling = addVariant(database, chat.id, message, ["Eve"], false, 1);
		const db = drizzle(database);
		const instance = readBoxLifecycles(db, chat.id).memory!.instance;
		db.update(messageVariantDataTable).set({ value: JSON.stringify({ automatic: { claims: 42 } }) }).where(and(
			eq(messageVariantDataTable.message_variant_id, sibling),
			eq(messageVariantDataTable.namespace, "box:memory"),
			eq(messageVariantDataTable.key, recordKey(instance)),
		)).run();

		const memory = exportsOf(database, chat.id);
		expect(memory.people()).toEqual(["Bob"]);
		expect(memory.selectedClaims()).toEqual([claimOf(message, ["Bob"])]);
	});

	test("a passage by an author who is not in the story is left out", async () => {
		const chat = createChat(database);
		const other = otherParticipant(database, chat.id);
		const message = addMessage(database, chat.id, 1, { id: other.id, name: "Alice" });
		addVariant(database, chat.id, message, ["Bob"]);
		expect(exportsOf(database, chat.id).people()).toEqual(["Bob"]);
		expect((await setIdentity(database, chat.id, other.id, { kind: "excluded" })).status).toBe(200);
		const memory = exportsOf(database, chat.id);
		expect(memory.people()).toEqual([]);
		expect(memory.selectedClaims()).toEqual([]);
	});

	test("a Cast member who plays a person resolves that person's Claims to the person's label", async () => {
		const chat = createChat(database);
		const other = otherParticipant(database, chat.id);
		const message = addMessage(database, chat.id, 1, { id: other.id, name: "Alice" });
		addVariant(database, chat.id, message, ["Alice"]);
		expect(exportsOf(database, chat.id).people()).toEqual(["Alice"]);
		expect((await setIdentity(database, chat.id, other.id, { kind: "plays", person: "Maren" })).status).toBe(200);
		const memory = exportsOf(database, chat.id);
		expect(memory.people()).toEqual(["Maren"]);
		expect(memory.selectedClaims()).toEqual([claimOf(message, ["Maren"])]);
	});
});
