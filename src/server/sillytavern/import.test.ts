import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { UNKNOWN_IMPORTED_AUTHOR_NAME } from "../../shared/imported-author";
import { processStateFor } from "../application/process-state";
import { readConversationSummary } from "../conversation";
import { conversationControlTable, conversationTable, participantTable } from "../database/schema";
import { importChatFixture } from "../test-fixtures/chat-import";
import { openObservedDatabase, requireSnapshot } from "../test-fixtures/conversation";
import { IMPORT_KEYS, IMPORT_NAMESPACE, VARIANT_KEYS } from "./adapter";
import {
	blankNameFixture as blankName,
	headerFixture as header,
	jsonl,
	provenancedPayloadFixture as provenancedPayload,
	rulershipFixture as second,
	swipeRecordFixture as swiped,
	writerFixture as first,
} from "./fixtures";
import { createChatImportModule, type ChatImportModule } from "./staged";

describe("SillyTavern chat import", () => {
	let database: Database;
	let directory: string;
	let module: ChatImportModule;

	beforeEach(() => {
		database = openObservedDatabase();
		directory = mkdtempSync(join(tmpdir(), "ditzytavern-import-"));
		module = createChatImportModule(database, { artifactDirectory: directory });
	});
	afterEach(() => {
		processStateFor(database).dispose();
		database.close();
		rmSync(directory, { recursive: true, force: true });
	});

	const importChat = (records: unknown[]) => importChatFixture(module, jsonl(records));
	const chatRow = (id: number) => drizzle(database).select().from(conversationTable).where(eq(conversationTable.id, id)).get();

	test("persists a payload-only import with Author Stamps and no historical Control", async () => {
		const { conversation } = await importChat([header, first, second, blankName]);
		const { id, cast } = conversation;
		const { messages } = requireSnapshot(database, id);

		expect(conversation).toMatchObject({ name: "lantern-house", revision: 0, playable: true });
		expect(messages.map((message) => message.position)).toEqual([1, 2, 3]);
		expect(messages.map((message) => message.author)).toEqual([
			{ participantId: cast[0]?.id, capturedName: "Writer", inCast: true },
			{ participantId: cast[1]?.id, capturedName: "Rulership", inCast: true },
			{ participantId: cast[2]?.id, capturedName: UNKNOWN_IMPORTED_AUTHOR_NAME, inCast: true },
		]);
		expect(messages[2]?.data).toContainEqual({ namespace: IMPORT_NAMESPACE, key: IMPORT_KEYS.authorName, value: "" });
		expect(messages.map((message) => message.historicalContext)).toEqual([null, null, null]);
		expect(messages.map((message) => message.swipe)).toEqual(
			Array.from({ length: 3 }, () => ({ eligible: false, reason: "missing-historical-context" })),
		);
		expect(chatRow(id)).toMatchObject({
			creation_time: "2026-08-08T12:53:02.008Z",
			last_message_time: "2026-08-08T13:10:00.000Z",
		});
		expect(readConversationSummary(database, id)).toEqual(conversation);
	});

	test("commits a zero-Participant source as an incomplete archive without Control rows", async () => {
		const { conversation } = await importChat([header]);
		expect(conversation).toMatchObject({
			cast: [],
			control: { humanParticipantId: null, modelParticipantId: null },
			controlValidity: { valid: false, reason: "missing-seat" },
			playable: false,
			capabilities: {
				compose: { available: false, reason: "conversation-not-playable" },
				generate: { available: false, reason: "conversation-not-playable" },
				swipe: { available: false, reason: "conversation-not-playable" },
			},
		});
		expect(requireSnapshot(database, conversation.id).messages).toEqual([]);
		expect(drizzle(database).select().from(conversationControlTable).all()).toHaveLength(0);
		expect(drizzle(database).select().from(participantTable).all()).toHaveLength(0);
	});

	test("reserves only the human seat for a one-Participant source and commits it incomplete", async () => {
		const { conversation } = await importChat([header, first]);
		const [writer] = conversation.cast;
		expect(conversation).toMatchObject({
			control: { humanParticipantId: writer?.id, modelParticipantId: null },
			playable: false,
		});
		expect(drizzle(database).select().from(conversationControlTable).all()).toHaveLength(1);
		const { messages } = requireSnapshot(database, conversation.id);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			author: { participantId: writer?.id, capturedName: "Writer", inCast: true },
			historicalContext: null,
			swipe: { eligible: false, reason: "conversation-not-playable" },
		});
	});

	test("persists Control in resolved order regardless of source role hints", async () => {
		const { conversation } = await importChat([header, second, first]);
		const [rulership, writer] = conversation.cast;
		expect([rulership?.name, writer?.name]).toEqual(["Rulership", "Writer"]);
		expect(conversation.control).toEqual({
			humanParticipantId: rulership?.id ?? null,
			modelParticipantId: writer?.id ?? null,
		});
	});

	test("keeps later resolved Participants unseated with removal eligibility", async () => {
		const records = [
			{ ...first, name: "Alpha" },
			{ ...second, name: "Beta" },
			{ ...first, name: "Gamma" },
			{ ...second, name: "Delta" },
		];
		const { conversation } = await importChat([header, ...records]);
		const [alpha, beta, gamma, delta] = conversation.cast;
		expect(conversation.control).toEqual({
			humanParticipantId: alpha?.id ?? null,
			modelParticipantId: beta?.id ?? null,
		});
		expect(gamma?.removal).toEqual({
			eligible: true,
			reason: null,
			deletionMode: "tombstone",
			affectedGenerationCount: 0,
		});
		expect(delta?.removal.eligible).toBe(true);
		expect(alpha?.removal.eligible).toBe(false);
		expect(beta?.removal.eligible).toBe(false);
	});

	test("persists one author for whitespace variants and keeps case distinct", async () => {
		const { conversation } = await importChat([header, first, { ...first, name: " Writer " }, { ...first, name: "writer" }]);
		const [writer, lowercaseWriter] = conversation.cast;
		expect(conversation.cast.map((participant) => participant.name)).toEqual(["Writer", "writer"]);
		const { messages } = requireSnapshot(database, conversation.id);
		expect(messages.map((message) => message.author?.participantId)).toEqual([writer?.id, writer?.id, lowercaseWriter?.id]);
		expect(messages.map((message) => message.data[0]?.value)).toEqual(["Writer", " Writer ", "writer"]);
	});

	test("persists one shared Participant for blank authors and keeps the raw values", async () => {
		const { conversation } = await importChat([header, blankName, { ...blankName, mes: "Another blank author." }]);
		const [participant] = conversation.cast;
		expect(conversation.cast.map((entry) => entry.name)).toEqual([UNKNOWN_IMPORTED_AUTHOR_NAME]);
		const { messages } = requireSnapshot(database, conversation.id);
		expect(messages.map((message) => message.author?.participantId)).toEqual([participant?.id, participant?.id]);
		expect(messages.map((message) => message.data[0]?.value)).toEqual(["", ""]);
	});

	test("keeps a blank group and a literal Blank Author group as distinct Participants", async () => {
		const { conversation } = await importChat([header, blankName, { ...second, name: "Blank Author" }]);
		const [blankGroup, literalGroup] = conversation.cast;
		expect(conversation.cast.map((participant) => participant.duplicateLabel)).toEqual([UNKNOWN_IMPORTED_AUTHOR_NAME, "Blank Author"]);
		expect(blankGroup?.id).not.toBe(literalGroup?.id);
		const { messages } = requireSnapshot(database, conversation.id);
		expect(messages.map((message) => message.author?.participantId)).toEqual([blankGroup?.id, literalGroup?.id]);
		expect(messages.map((message) => message.data[0]?.value)).toEqual(["", "Blank Author"]);
	});

	test("commits a confirmed exact duplicate as an independent Chat with a warning", async () => {
		const { conversation: prior, receipt: priorReceipt } = await importChat([header, first, second]);
		const { conversation, receipt } = await importChat([header, first, second]);

		expect(conversation.id).not.toBe(prior.id);
		expect(receipt.duplicates.exact).toEqual([{ id: prior.id, name: prior.name }]);
		const warning = `Source was already imported as chat ${prior.id} ("lantern-house"); this import creates an independent copy.`;
		expect(receipt.warnings).toEqual([warning]);
		expect(priorReceipt.warnings).toEqual([]);
		const { data } = requireSnapshot(database, conversation.id);
		expect(data).toContainEqual({ namespace: IMPORT_NAMESPACE, key: IMPORT_KEYS.warnings, value: JSON.stringify([warning]) });
	});

	test("persists imported Swipe selection, scoped provenance, and Chat chronology", async () => {
		const { conversation } = await importChat([header, swiped, provenancedPayload]);
		const { messages } = requireSnapshot(database, conversation.id);
		const [swipeMessage, payloadMessage] = messages;
		expect(swipeMessage?.variants.map((variant) => variant.selected)).toEqual([false, true, false, false]);
		expect(swipeMessage?.variants[0]?.data).toContainEqual({
			namespace: IMPORT_NAMESPACE,
			key: VARIANT_KEYS.reasoningSignature,
			value: "signature-abc",
		});
		expect(payloadMessage?.variants[0]?.data).toContainEqual({
			namespace: IMPORT_NAMESPACE,
			key: VARIANT_KEYS.reasoningSignature,
			value: "signature-row",
		});
		expect(chatRow(conversation.id)).toMatchObject({
			creation_time: "2026-08-08T13:04:50.000Z",
			last_message_time: "2026-08-08T13:30:00.000Z",
		});
	});
});
