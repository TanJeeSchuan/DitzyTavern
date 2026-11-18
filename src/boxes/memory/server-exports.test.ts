import { boxDescriptor } from "../../shared/contract/box";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { readParticipants } from "@/box-sdk/server";
import { openInitializedDatabase } from "../../server/database/database";
import { createChat } from "../../server/contract/prompt-preset-test-fixtures";
import { messageTable, messageVariantTable } from "../../server/database/schema";
import { sha256 } from "../../server/hash";
import { writeAutomaticRecord, writeWriterRecord } from "../../server/box/records";
import { readBoxLifecycles } from "../../server/box/setup";
import { boxExports } from "../../server/box/exports";
import { memoryRoutes } from "./server-routes";
import { readMemoryLabelState } from "./server-chat";
import type { MemoryCandidateJudgment, MemoryIdentity } from "./contract";

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
type LabelCommand = { expectedRevision: string } & ({ labels: string[]; destination: string } | { participantId: number; identity: MemoryIdentity });
const command = (database: Database, conversationId: number, path: string, body: LabelCommand) =>
	memoryRoutes(database).handle(new Request(`http://localhost/conversations/${conversationId}/memories/${path}`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
	}));
const merge = (database: Database, conversationId: number, labels: string[], destination: string) =>
	command(database, conversationId, "merge-labels", { labels, destination, expectedRevision: readMemoryLabelState(database, conversationId).revision });
const setIdentity = (database: Database, conversationId: number, participantId: number, identity: MemoryIdentity) =>
	command(database, conversationId, "identity", { expectedRevision: readMemoryLabelState(database, conversationId).revision, participantId, identity });

/** The Chat's second Cast member, the one the human does not play. */
const otherParticipant = (database: Database, conversationId: number) => {
	const [, other] = readParticipants(database, conversationId);
	if (other === undefined) throw new Error("The Chat's second Participant is missing.");
	return other;
};

/** The Chat's Memory Exports, refusing a Chat that lost them. */
const exportsOf = (database: Database, conversationId: number) => {
	const { people, claimsAbout } = boxExports(database, conversationId).memory ?? {};
	if (people === undefined || claimsAbout === undefined) throw new Error("Memory's Exports are missing.");
	return { people, claimsAbout };
};

describe("Memory's Exports", () => {
	let database: Database;
	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("people() lists the labels on the Selected narrative path after label merges, and claimsAbout() returns the Claims whose merged people include the label", async () => {
		const chat = createChat(database);
		const first = addMessage(database, chat.id, 1);
		addVariant(database, chat.id, first, ["Bob"]);
		const second = addMessage(database, chat.id, 2);
		addVariant(database, chat.id, second, ["Bob", "Alice"]);
		expect((await merge(database, chat.id, ["Bob"], "Bartholomew Crane")).status).toBe(200);
		const memory = exportsOf(database, chat.id);
		expect(memory.people()).toEqual(["Bartholomew Crane", "Alice"]);
		expect(memory.claimsAbout({ label: "Bartholomew Crane" })).toEqual([
			claimOf(first, ["Bartholomew Crane"]),
			claimOf(second, ["Bartholomew Crane", "Alice"]),
		]);
		expect(memory.claimsAbout({ label: "Alice" })).toEqual([claimOf(second, ["Bartholomew Crane", "Alice"])]);
		expect(memory.claimsAbout({ label: "Bob" })).toEqual([]);
	});

	test("a Writer override's Claims are the ones an Export answers with", () => {
		const chat = createChat(database);
		const message = addMessage(database, chat.id, 1);
		const variant = addVariant(database, chat.id, message, ["Maren"]);
		writeWriterRecord(drizzle(database), boxDescriptor("memory"), readBoxLifecycles(drizzle(database), chat.id).memory!.instance, variant,
			{ claims: [candidate(message, ["Maren"], "Maren kept the key.")] });
		const memory = exportsOf(database, chat.id);
		expect(memory.people()).toEqual(["Maren"]);
		expect(memory.claimsAbout({ label: "Maren" })).toEqual([claimOf(message, ["Maren"], "Maren kept the key.")]);
	});

	test("Claims on a swiped-away Variant are left out", () => {
		const chat = createChat(database);
		const message = addMessage(database, chat.id, 1);
		addVariant(database, chat.id, message, ["Bob"], true, 0);
		addVariant(database, chat.id, message, ["Eve"], false, 1);
		const memory = exportsOf(database, chat.id);
		expect(memory.people()).toEqual(["Bob"]);
		expect(memory.claimsAbout({ label: "Eve" })).toEqual([]);
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
		expect(memory.claimsAbout({ label: "Bob" })).toEqual([]);
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
		expect(memory.claimsAbout({ label: "Maren" })).toEqual([claimOf(message, ["Maren"])]);
		expect(memory.claimsAbout({ label: "Alice" })).toEqual([]);
	});
});
