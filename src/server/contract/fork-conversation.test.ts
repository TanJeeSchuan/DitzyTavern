import { afterEach, beforeEach, expect, test } from "bun:test";
import { createConversationWithHistory, openObservedDatabase, insertBox, readTestConversationSnapshot } from "../test-fixtures/conversation";
import { executeConversationCommand, readConversationSummary, readChatHistory, deleteConversation, acceptConversationTailGeneration } from "../conversation";
import { forkConversation } from "../conversation";
import type { Database } from "bun:sqlite";
import { Value } from "@sinclair/typebox/value";
import { Type } from "@sinclair/typebox";
import { installedBoxes, installBoxes } from "../../shared/contract/box";
import { VariantId } from "../../shared/contract/box-row-reference";
import { memoryRecord, memoryActivationRecord } from "../../boxes/memory/contract";
import { memoryRecordFingerprint, readMemorySources } from "../../boxes/memory/server-sources";
import { raceSetup } from "../../boxes/race/contract";
import { advanceRace } from "../../boxes/race/server-engine";
import { fillRaceField, initialRaceSetup } from "../../boxes/race/shared-data";
import { createBoxWindowRoutes } from "./box-window";
import { createConversationRoutes } from "./conversation";

let database: Database;
beforeEach(() => { database = openObservedDatabase(); });
afterEach(() => database.close());

test("forks through a selected alternative and leaves later Messages behind", async () => {
	const prompt = { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" };
	const source = createConversationWithHistory(database, {
		name: "Source", participants: [{ definition: { name: "Writer", prompt, openings: [] } }, { definition: { name: "Model", prompt, openings: ["first", "alternative"] } }], control: { human: 0, model: 1 },
	});
	executeConversationCommand(database, { conversationId: source.id, expectedRevision: source.revision, action: { type: "create-message", timestamp: "2026-01-01T00:00:00Z", variantContents: ["later"], authorParticipantId: source.cast[0]!.id } });
	const app = createConversationRoutes(database);
	const response = await app.handle(new Request(`http://localhost/api/conversations/${source.id}/fork`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 1, at: { through: source.messages[0]!.id, variantId: source.messages[0]!.variants[1]!.id }, trimVariants: true, name: "Fork" }),
	}));
	if (response.status !== 200) throw new Error(await response.text());
	const result = await response.json();
	expect(result.conversation.name).toBe("Fork");
	expect(result.conversation.forkedFrom).toEqual({ conversationId: source.id, messageId: source.messages[0]!.id, name: "Source" });
	const history = await app.handle(new Request(`http://localhost/api/conversations/${result.conversation.id}/history`));
	const body = JSON.stringify(await history.json());
	expect(body).toContain("alternative");
	expect(body).not.toContain("later");
	const copied = readTestConversationSnapshot(database, result.conversation.id)!;
	expect(copied.messages).toHaveLength(1);
	expect(copied.messages[0]!.variants.map(({ content, selected }) => ({ content, selected }))).toEqual([{ content: "alternative", selected: true }]);
});

const createSource = () => {
	const prompt = { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" };
	const source = createConversationWithHistory(database, { name: "Source", participants: [{ definition: { name: "Writer", prompt, openings: [] } }, { definition: { name: "Model", prompt, openings: [] } }], control: { human: 0, model: 1 } });
	executeConversationCommand(database, { conversationId: source.id, expectedRevision: 0, action: { type: "create-message", timestamp: "2026-01-01T00:00:00Z", variantContents: ["Rewrite me"], authorParticipantId: source.cast[0]!.id } });
	const message = database.query<{ id: number }, [number]>("SELECT id FROM messages WHERE conversation_id = ?").get(source.id)!;
	return { source, message };
};

test("rewind returns the original draft and an empty history without changing its source", () => {
	const { source, message } = createSource();
	const fork = forkConversation(database, { conversationId: source.id, expectedRevision: 1, at: { rewind: message.id }, name: "Rewind", trimVariants: false });
	expect(fork.rewind).toEqual({ content: "Rewrite me", moves: {} });
	expect(database.query<{ count: number }, [number]>("SELECT count(*) AS count FROM messages WHERE conversation_id = ?").get(fork.conversation.id)!.count).toBe(0);
	expect(readConversationSummary(database, source.id)!.revision).toBe(1);
});

test("Rewind follows ADR-0035's authorship rule after seats swap", () => {
	const { source, message } = createSource();
	const swapped = executeConversationCommand(database, { conversationId: source.id, expectedRevision: 1, action: { type: "assign-control", seat: "human", participantId: source.cast[1]!.id } });
	expect(readChatHistory(database, source.id)!.messages[0]!.authorRole).not.toBe("human");
	expect(() => forkConversation(database, { conversationId: source.id, expectedRevision: swapped.revision, at: { rewind: message.id }, name: "Rewind", trimVariants: false })).toThrow("Only a Human-authored Message can be rewound.");
});

test("deleting a source with both Fork link columns set clears the link", () => {
	const { source, message } = createSource();
	const fork = forkConversation(database, { conversationId: source.id, expectedRevision: 1, at: { through: message.id }, name: "Fork", trimVariants: false }).conversation;
	deleteConversation(database, source.id);
	expect(readConversationSummary(database, fork.id)!.forkedFrom).toBeNull();
});

test("fork links follow their immediate source, survive message deletion, and clear on source deletion", () => {
	const { source, message } = createSource();
	const first = forkConversation(database, { conversationId: source.id, expectedRevision: 1, at: { through: message.id }, name: "First", trimVariants: false }).conversation;
	const firstMessage = database.query<{ id: number }, [number]>("SELECT id FROM messages WHERE conversation_id = ?").get(first.id)!;
	const second = forkConversation(database, { conversationId: first.id, expectedRevision: 0, at: { through: firstMessage.id }, name: "Second", trimVariants: false }).conversation;
	expect(second.forkedFrom).toEqual({ conversationId: first.id, messageId: firstMessage.id, name: "First" });
	executeConversationCommand(database, { conversationId: first.id, expectedRevision: 0, action: { type: "delete-message", messageId: firstMessage.id } });
	expect(readConversationSummary(database, second.id)!.forkedFrom).toEqual({ conversationId: first.id, messageId: null, name: "First" });
	deleteConversation(database, first.id);
	expect(readConversationSummary(database, second.id)!.forkedFrom).toBeNull();
});

test("missing Box references reject the entire fork and unloaded Boxes are omitted", () => {
	const { source, message } = createSource();
	database.query("INSERT INTO conversation_data (conversation_id, namespace, key, value) VALUES (?, 'box:memory', 'labels', ?)").run(source.id, JSON.stringify({ identities: { "999999": { kind: "themselves" } }, merges: [] }));
	const input = { conversationId: source.id, expectedRevision: 1, at: { through: message.id }, name: "Fork", trimVariants: false };
	expect(() => forkConversation(database, input)).toThrow(/memory.*\/identities\/999999/);
	expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM conversation").get()!.count).toBe(1);
	database.query("DELETE FROM conversation_data WHERE namespace = 'box:memory' AND key = 'labels'").run();
	database.query("INSERT INTO conversation_data (conversation_id, namespace, key, value) VALUES (?, 'box:missing', 'setup', '{}')").run(source.id);
	const fork = forkConversation(database, input);
	expect(fork.omittedBoxes).toEqual(["missing"]);
	expect(database.query<{ count: number }, [number]>("SELECT count(*) AS count FROM conversation_data WHERE conversation_id = ? AND namespace = 'box:missing'").get(fork.conversation.id)!.count).toBe(0);
});

test("revision and fork point validation leave the source and Chat list unchanged", () => {
	const { source, message } = createSource();
	const input = { conversationId: source.id, expectedRevision: 1, at: { through: message.id }, name: "Fork", trimVariants: false };
	expect(() => forkConversation(database, { ...input, expectedRevision: 0 })).toThrow();
	expect(() => forkConversation(database, { ...input, at: { through: 99999 } })).toThrow("not a Message");
	expect(() => forkConversation(database, { ...input, at: { through: message.id, variantId: 99999 } })).toThrow("not on the fork point");
	expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM conversation").get()!.count).toBe(1);
});

test("unlink removes a fork link under revision control", () => {
	const { source, message } = createSource();
	const fork = forkConversation(database, { conversationId: source.id, expectedRevision: 1, at: { through: message.id }, name: "Fork", trimVariants: false }).conversation;
	expect(() => executeConversationCommand(database, { conversationId: fork.id, expectedRevision: 1, action: { type: "unlink-fork" } })).toThrow();
	const updated = executeConversationCommand(database, { conversationId: fork.id, expectedRevision: 0, action: { type: "unlink-fork" } });
	expect(updated.forkedFrom).toBeNull();
	expect(updated.revision).toBe(1);
});

test("a Rewind returns the Human Message's Moves without storing the Message", () => {
	const { source, message } = createSource();
	database.query("INSERT INTO messages_data (message_id, namespace, key, value) VALUES (?, 'box:phone', 'moves', ?)").run(message.id, JSON.stringify([{ to: "Model", text: "Hello" }]));
	const fork = forkConversation(database, { conversationId: source.id, expectedRevision: 1, at: { rewind: message.id }, name: "Fork", trimVariants: false });
	expect(fork.rewind).toEqual({ content: "Rewrite me", moves: { phone: [{ to: "Model", text: "Hello" }] } });
	expect(database.query<{ count: number }, [number]>("SELECT count(*) AS count FROM messages WHERE conversation_id = ?").get(fork.conversation.id)!.count).toBe(0);
});


test("fork is refused during an Active Generation", () => {
	const { source, message } = createSource();
	acceptConversationTailGeneration(database, {
		seed: "seed", conversationId: source.id, expectedRevision: 1, timestamp: "2026-01-01T00:01:00Z",
		humanContent: "Go on", humanParticipantId: source.cast[0]!.id, modelParticipantId: source.cast[1]!.id, capturedModelName: "Model",
		promptPlan: { blocks: [], warnings: [], images: [] },
		promptInspection: { tokenEstimate: 1, responseBudget: 64, safetyAllowance: 0, contextLimit: 128, totalRequiredTokens: 65, omittedContext: [] },
		promptContext: [], generationSettings: {}, connection: {},
	});
	const revision = readConversationSummary(database, source.id)!.revision;
	expect(() => forkConversation(database, { conversationId: source.id, expectedRevision: revision, at: { through: message.id }, name: "Fork", trimVariants: false })).toThrow("Active Generation");
	expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM conversation").get()!.count).toBe(1);
});

test("a Memory record citing a Message beyond the fork point rolls back the fork", () => {
	const { source, message } = createSource();
	const revision = executeConversationCommand(database, { conversationId: source.id, expectedRevision: 1, action: { type: "create-message", timestamp: "2026-01-02T00:00:00Z", variantContents: ["later"], authorParticipantId: source.cast[1]!.id } }).revision;
	const later = database.query<{ id: number }, [number]>("SELECT id FROM messages WHERE conversation_id = ? ORDER BY position DESC LIMIT 1").get(source.id)!;
	const variant = database.query<{ id: number }, [number]>("SELECT id FROM message_variant WHERE message_id = ?").get(message.id)!;
	const instance = database.query<{ value: string }, [number]>("SELECT value FROM conversation_data WHERE conversation_id = ? AND namespace = 'box:memory' AND key = 'instance'").get(source.id)!.value;
	const claim = { claim: "Fact", attribution: "Writer", people: [], evidence: [{ messageId: later.id, excerpt: "later" }], judgment: { support: "supported", attribution: "correct", usefulness: "retain", probabilities: {}, confidence: {} } };
	database.query("INSERT INTO message_variant_data (message_variant_id, namespace, key, value) VALUES (?, 'box:memory', ?, ?)").run(variant.id, `record:${instance}`, JSON.stringify({ writer: { claims: [claim] } }));
	expect(() => forkConversation(database, { conversationId: source.id, expectedRevision: revision, at: { through: message.id }, name: "Fork", trimVariants: true })).toThrow(/memory.*\/writer\/claims\/0\/evidence\/0\/messageId/);
	expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM conversation").get()!.count).toBe(1);
});

test("Memory traces remap copied IDs and retain IDs of trimmed Variants", () => {
	const { source, message } = createSource();
	const variants = database.query<{ id: number }, [number]>("SELECT id FROM message_variant WHERE message_id = ?").all(message.id);
	const variant = variants[0]!;
	database.query("INSERT INTO message_variant (message_id, position, content, timestamp, selected) VALUES (?, 2, 'Alternative', '2026-01-01', 0)").run(message.id);
	const trimmed = database.query<{ id: number }, [number]>("SELECT id FROM message_variant WHERE message_id = ? AND selected = 0").get(message.id)!;
	const candidate = { identity: "c", messageId: message.id, variantId: trimmed.id, writer: false, sourceChanged: false, claimIndex: 0, sourcePosition: 1, semanticSimilarity: null, semanticRank: null, recentRank: null, relevance: null, relevanceScore: null, admission: "admitted" };
	const record = Value.Parse(memoryRecord, { claims: [{ claim: "Fact", attribution: "Writer", people: [], evidence: [{ messageId: message.id, excerpt: "Fact" }], judgment: { support: "supported", attribution: "correct", usefulness: "retain", probabilities: {}, confidence: {} } }] });
	const instance = database.query<{ value: string }, [number]>("SELECT value FROM conversation_data WHERE conversation_id = ? AND namespace = 'box:memory' AND key = 'instance'").get(source.id)!.value;
	database.query("INSERT INTO message_variant_data (message_variant_id, namespace, key, value) VALUES (?, 'box:memory', ?, ?)").run(variant.id, `record:${instance}`, JSON.stringify({ writer: record }));
	const recalled = { ...candidate, variantId: variant.id, identity: `${message.id}:${variant.id}:0:${memoryRecordFingerprint(record)}` };
	const trace = { state: "ready", allowance: 10, eligibleSourceCount: 1, readyRecordCount: 1, embeddingModel: "", embeddingDeadlineMs: 0, decisionProfileName: null, decisionModel: "", decisionConfigured: false, relevanceMinimum: 0, pendingSourceCount: 0, failedSourceCount: 0, sourceSnapshotFingerprint: "", embeddingConfigurationFingerprint: "", scanMessageIds: [message.id], scanTruncated: false, scene: "", semanticShortlistCount: 0, recentShortlistCount: 0, candidates: [candidate, recalled] };
	database.query("INSERT INTO message_variant_data (message_variant_id, namespace, key, value) VALUES (?, 'generation-box', 'traces', ?)").run(variant.id, JSON.stringify({ "box:memory": { trace, items: [], automaticText: "", finalText: "" } }));
	const fork = forkConversation(database, { conversationId: source.id, expectedRevision: 1, at: { through: message.id }, name: "Fork", trimVariants: true });
	const copied = database.query<{ id: number }, [number]>("SELECT id FROM messages WHERE conversation_id = ?").get(fork.conversation.id)!;
	const row = database.query<{ value: string }, [number]>("SELECT d.value FROM message_variant_data d JOIN message_variant v ON v.id = d.message_variant_id JOIN messages m ON m.id = v.message_id WHERE m.conversation_id = ? AND d.namespace = 'generation-box'").get(fork.conversation.id)!;
	const saved = JSON.parse(row.value)["box:memory"].trace;
	expect(saved.scanMessageIds).toEqual([copied.id]);
	expect(saved.candidates[0].messageId).toBe(copied.id);
	expect(saved.candidates[0].variantId).toBe(trimmed.id);
	const copiedTrace = Value.Parse(memoryActivationRecord, saved);
	const copiedClaim = copiedTrace.candidates[1]!;
	expect(copiedClaim.variantId).not.toBe(variant.id);
	const resolved = readMemorySources(database, fork.conversation.id, { messageIds: [copied.id], variantIds: [copiedClaim.variantId, trimmed.id] });
	expect(resolved.records).toMatchObject([{ variantId: copiedClaim.variantId, fingerprint: copiedClaim.identity.split(":").at(-1), claims: [{ claim: "Fact", evidence: [{ messageId: copied.id, excerpt: "Fact" }] }] }]);
});


test("World Clock and Macro State stop at the fork point", async () => {
	const { source, message } = createSource();
	const clock = insertBox(database, source.id, "world-clock");
	const variant = database.query<{ id: number }, [number]>("SELECT id FROM message_variant WHERE message_id = ?").get(message.id)!;
	database.query("INSERT INTO message_variant_data (message_variant_id, namespace, key, value) VALUES (?, 'box:world-clock', ?, ?)").run(variant.id, `record:${clock}`, JSON.stringify({ writer: { minutes: 60, weather: "rain" } }));
	database.query("INSERT INTO message_variant_data (message_variant_id, namespace, key, value) VALUES (?, 'prompt-macro', 'write:1', ?)").run(variant.id, JSON.stringify([{ name: "turn", operation: "set", value: 3 }]));
	const revision = executeConversationCommand(database, { conversationId: source.id, expectedRevision: 1, action: { type: "create-message", timestamp: "2026-01-02T00:00:00Z", variantContents: ["later"], authorParticipantId: source.cast[1]!.id } }).revision;
	const later = database.query<{ id: number }, [number]>("SELECT v.id FROM message_variant v JOIN messages m ON m.id = v.message_id WHERE m.conversation_id = ? ORDER BY m.position DESC LIMIT 1").get(source.id)!;
	database.query("INSERT INTO message_variant_data (message_variant_id, namespace, key, value) VALUES (?, 'box:world-clock', ?, ?)").run(later.id, `record:${clock}`, JSON.stringify({ writer: { minutes: 120, weather: null } }));
	database.query("INSERT INTO message_variant_data (message_variant_id, namespace, key, value) VALUES (?, 'prompt-macro', 'write:1', ?)").run(later.id, JSON.stringify([{ name: "turn", operation: "set", value: 5 }]));
	const fork = forkConversation(database, { conversationId: source.id, expectedRevision: revision, at: { through: message.id }, name: "Fork", trimVariants: false });
	const boxes = createBoxWindowRoutes(database);
	const readClock = async (id: number) => (await (await boxes.handle(new Request(`http://localhost/api/conversations/${id}/boxes/world-clock`))).json()).status;
	expect(await readClock(source.id)).toMatch(/^11:00 AM/);
	expect(await readClock(fork.conversation.id)).toMatch(/^9:00 AM/);
	const app = createConversationRoutes(database);
	const readVariables = async (id: number) => (await (await app.handle(new Request(`http://localhost/api/conversations/${id}/macro-variables`))).json()).variables;
	expect(JSON.stringify(await readVariables(fork.conversation.id))).toContain('"value":3');
	expect(JSON.stringify(await readVariables(source.id))).toContain('"value":5');
});


test("a Race started after the fork point starts at zero in the fork", async () => {
	const { source, message } = createSource();
	const race = insertBox(database, source.id, "race");
	const slots = fillRaceField([], [], "field");
	const setup = { ...initialRaceSetup, raceId: "race-a", phase: "running" as const, slots: slots.map((slot, index) => index === 0 ? { ...slot, participantId: source.cast[0]!.id } : slot) };
	database.query("INSERT INTO conversation_data (conversation_id, namespace, key, value) VALUES (?, 'box:race', 'setup', ?)").run(source.id, JSON.stringify(setup));
	const revision = executeConversationCommand(database, { conversationId: source.id, expectedRevision: 1, action: { type: "create-message", timestamp: "2026-01-02T00:00:00Z", variantContents: ["A stretch"], authorParticipantId: source.cast[1]!.id } }).revision;
	const later = database.query<{ id: number }, [number]>("SELECT v.id FROM message_variant v JOIN messages m ON m.id = v.message_id WHERE m.conversation_id = ? ORDER BY m.position DESC LIMIT 1").get(source.id)!;
	const record = advanceRace({ setup, state: null, seed: "stretch", intent: "respond", moves: [] })!.record;
	database.query("INSERT INTO message_variant_data (message_variant_id, namespace, key, value) VALUES (?, 'box:race', ?, ?)").run(later.id, `record:${race}`, JSON.stringify({ writer: record }));
	const fork = forkConversation(database, { conversationId: source.id, expectedRevision: revision, at: { through: message.id }, name: "Fork", trimVariants: false });
	expect(Value.Parse(raceSetup, fork.conversation.boxSetups.race).slots[0]!.participantId).toBe(fork.conversation.cast[0]!.id);
	const app = createBoxWindowRoutes(database);
	const read = async (id: number) => (await (await app.handle(new Request(`http://localhost/api/conversations/${id}/boxes/race`))).json()).state;
	const sourceState = await read(source.id);
	expect(sourceState.stretch).toBe(1);
	expect(await read(fork.conversation.id)).toMatchObject({ raceId: "race-a", stretch: 0, metres: 0 });
	const laterMessage = database.query<{ id: number }, [number]>("SELECT id FROM messages WHERE conversation_id = ? ORDER BY position DESC LIMIT 1").get(source.id)!;
	const afterStretch = forkConversation(database, { conversationId: source.id, expectedRevision: revision, at: { through: laterMessage.id }, name: "After", trimVariants: false });
	expect(await read(afterStretch.conversation.id)).toEqual(sourceState);
});

test("editing a fork leaves the source unchanged", () => {
	const { source, message } = createSource();
	const fork = forkConversation(database, { conversationId: source.id, expectedRevision: 1, at: { through: message.id }, name: "Fork", trimVariants: false }).conversation;
	const copied = database.query<{ message_id: number; id: number }, [number]>("SELECT m.id AS message_id, v.id FROM messages m JOIN message_variant v ON v.message_id = m.id WHERE m.conversation_id = ?").get(fork.id)!;
	executeConversationCommand(database, { conversationId: fork.id, expectedRevision: 0, action: { type: "edit-variant", messageId: copied.message_id, variantId: copied.id, content: "Changed" } });
	expect(database.query<{ content: string }, [number]>("SELECT content FROM message_variant WHERE message_id = ? AND selected = 1").get(message.id)!.content).toBe("Rewrite me");
});


test("a trace without its Box schema fails without creating a fork", () => {
	const { source, message } = createSource();
	const variant = database.query<{ id: number }, [number]>("SELECT id FROM message_variant WHERE message_id = ?").get(message.id)!;
	database.query("INSERT INTO message_variant_data (message_variant_id, namespace, key, value) VALUES (?, 'generation-box', 'traces', ?)").run(variant.id, JSON.stringify({ "box:author-note": { trace: { messageId: message.id }, items: [], automaticText: "", finalText: "" } }));
	expect(() => forkConversation(database, { conversationId: source.id, expectedRevision: 1, at: { through: message.id }, name: "Fork", trimVariants: false })).toThrow(/author-note.*no schema.*trace/);
	expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM conversation").get()!.count).toBe(1);
});


test("a record citing a trimmed Variant fails with the Box and path", () => {
	const { source, message } = createSource();
	const variant = database.query<{ id: number }, [number]>("SELECT id FROM message_variant WHERE message_id = ?").get(message.id)!;
	database.query("INSERT INTO message_variant (message_id, position, content, timestamp, selected) VALUES (?, 2, 'Alternative', '2026-01-01', 0)").run(message.id);
	const trimmed = database.query<{ id: number }, [number]>("SELECT id FROM message_variant WHERE message_id = ? AND selected = 0").get(message.id)!;
	const boxes = [...installedBoxes().values()];
	const memory = boxes.find(({ metadata }) => metadata.id === "memory")!;
	// eslint-disable-next-line ditzy/no-contract-definition-outside-contract -- This is a test Box record schema.
	installBoxes(boxes.map((box) => box === memory ? { ...box, descriptor: { ...memory.descriptor!, record: Type.Object({ citation: VariantId }) } } : box));
	try {
		database.query("INSERT INTO message_variant_data (message_variant_id, namespace, key, value) VALUES (?, 'box:memory', 'record:test', ?)").run(variant.id, JSON.stringify({ writer: { citation: trimmed.id } }));
		expect(() => forkConversation(database, { conversationId: source.id, expectedRevision: 1, at: { through: message.id }, name: "Fork", trimVariants: true })).toThrow(/memory.*\/writer\/citation/);
		expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM conversation").get()!.count).toBe(1);
	} finally { installBoxes(boxes); }
});

test("a non-trimmed fork keeps every Variant while selecting the requested one", () => {
	const prompt = { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" };
	const source = createConversationWithHistory(database, { name: "Source", participants: [{ definition: { name: "Writer", prompt, openings: [] } }, { definition: { name: "Model", prompt, openings: ["First", "Second"] } }], control: { human: 0, model: 1 } });
	const point = source.messages[0]!;
	const fork = forkConversation(database, { conversationId: source.id, expectedRevision: 0, at: { through: point.id, variantId: point.variants[1]!.id }, name: "Fork", trimVariants: false });
	const variants = readTestConversationSnapshot(database, fork.conversation.id)!.messages[0]!.variants;
	expect(variants.map(({ content, selected }) => ({ content, selected }))).toEqual([{ content: "First", selected: false }, { content: "Second", selected: true }]);
	expect(() => forkConversation(database, { conversationId: source.id, expectedRevision: 0, at: { rewind: point.id }, name: "Rewind", trimVariants: false })).toThrow("Human-authored");
});
