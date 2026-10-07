import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Value } from "@sinclair/typebox/value";
import { openInitializedDatabase } from "../database/database";
import { memoryCollectionTable, messageTable, messageVariantTable } from "../database/schema";
import { createChat, key, profile } from "./prompt-preset-test-fixtures";
import { createMemoryRoutes } from "./memory";
import { correctMemorySource, queueMemorySource, queueMemoryTail, readConversationMemories, resetAndReextractMemorySource, startMemoryWorker, StaleMemoryCollectionError } from "../memory/collections";
import { mergeMemoryLabels } from "../memory/labels";
import { extractAndJudgeMemorySource } from "../memory/extraction";
import { createConnectionSettingsModule } from "../connection-settings";
import { initializeConnectionSecretKey } from "../connection-secrets";
import { createMemorySettingsModule } from "../memory/settings";
import { configureDecisionModels } from "./decision-model-test-fixtures";
import { sha256 } from "../memory/hash";
import { conversationMemories, memoryCatchupQueued, memoryLabelsConflict, memoryLabelsMerged, type CapturedMemoryMessage, type MemoryCandidateJudgment, type MemoryIdentity } from "../../shared/contract/memory";

const claim = (messageId: number, people: string[]): MemoryCandidateJudgment => ({ claim: "Maren promised a key.", attribution: "Narrated event", people, evidence: [{ messageId, excerpt: "I promised a key." }], judgment: { support: "supported", attribution: "correct", usefulness: "retain", probabilities: {}, confidence: {} } });
const source = (database: Database, conversationId: number, position: number, author: { id: number; name: string }, people?: string[], selected = true) => {
	const db = drizzle(database);
	const message = db.insert(messageTable).values({ conversation_id: conversationId, position, timestamp: "2026-10-07T00:00:00Z", author_participant_id: author.id, author_name: author.name }).returning().get();
	const variant = db.insert(messageVariantTable).values({ message_id: message.id, position: 0, timestamp: message.timestamp, content: "I promised a key.", selected }).returning().get();
	if (people) db.insert(memoryCollectionTable).values({ conversation_id: conversationId, message_id: message.id, variant_id: variant.id, revision: 1, status: "complete", source_hash: sha256(variant.content), source_snapshot_json: JSON.stringify({ source: { messageId: message.id, variantId: variant.id, speaker: author.name, content: variant.content }, context: [] }), claims_json: JSON.stringify([claim(message.id, people)]), updated_at: message.timestamp }).run();
	return { messageId: message.id, variantId: variant.id };
};
const catchup = async (database: Database, conversationId: number) => Value.Parse(memoryCatchupQueued, await (await createMemoryRoutes(database).handle(new Request(`http://localhost/api/conversations/${conversationId}/memories/catchup`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))).json()).run;
const save = (database: Database, conversationId: number, participantId: number, identity: MemoryIdentity, expectedRevision = readConversationMemories(database, conversationId).labelRevision) => createMemoryRoutes(database).handle(new Request(`http://localhost/api/conversations/${conversationId}/memories/identity`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ participantId, identity, expectedRevision }) }));
const waitFor = async (check: () => boolean) => {
	const deadline = Date.now() + 4000;
	while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	expect(check()).toBe(true);
};

describe("Cast Memory identities", () => {
	let database: Database;
	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("exposes current and captured Memory names in first-seen order for each participant", async () => {
		const chat = createChat(database);
		const writer = chat.cast[0]!;
		source(database, chat.id, 4, writer);
		source(database, chat.id, 1, { ...writer, name: "Guide" });
		source(database, chat.id, 2, writer);
		database.run("UPDATE participant SET name = 'Director' WHERE id = ?", [writer.id]);
		source(database, chat.id, 3, { ...writer, name: "Director" });
		const unknown = source(database, chat.id, 5, writer);
		database.run("UPDATE messages SET author_name = NULL WHERE id = ?", [unknown.messageId]);
		const response = await createMemoryRoutes(database).handle(new Request(`http://localhost/api/conversations/${chat.id}/memories`));
		expect(response.status).toBe(200);
		expect(Value.Parse(conversationMemories, await response.json()).cast).toEqual([{ id: writer.id, names: ["Director", "Guide", "Writer"] }, { id: chat.cast[1]!.id, names: ["Maren"] }]);
	});

	test("skips guidance in catch-up, tail, direct and reset queues while retaining reference context", async () => {
		const chat = createChat(database);
		const writer = chat.cast[0]!;
		const maren = chat.cast[1]!;
		const guidance = source(database, chat.id, 1, writer);
		const story = source(database, chat.id, 2, maren);
		expect((await save(database, chat.id, writer.id, { kind: "excluded" })).status).toBe(200);
		expect((await catchup(database, chat.id)).pending).toBe(1);
		expect(queueMemorySource(database, chat.id, guidance.messageId)).toBe(false);
		const tail = source(database, chat.id, 3, writer);
		expect(queueMemoryTail(database, chat.id)).toBe(false);
		expect(() => resetAndReextractMemorySource(database, chat.id, tail.messageId, tail.variantId, 0)).toThrow("not Memory sources");
		const view = readConversationMemories(database, chat.id);
		expect(view.path).toMatchObject([{ messageId: guidance.messageId, authorParticipantId: writer.id }, { messageId: story.messageId, authorParticipantId: maren.id }, { messageId: tail.messageId, authorParticipantId: writer.id }]);
		expect(view.sources.map((entry) => entry.messageId)).toEqual([story.messageId]);
		const captured: CapturedMemoryMessage[][] = [];
		const stop = startMemoryWorker(database, { process: async (_, context) => { captured.push([...context]); return []; } });
		try { await waitFor(() => readConversationMemories(database, chat.id).sources[0]?.status === "complete"); expect(captured).toMatchObject([[{ messageId: guidance.messageId, speaker: "Writer", content: "I promised a key." }]]); }
		finally { await stop(); }
		const nextStory = source(database, chat.id, 4, maren);
		expect(queueMemoryTail(database, chat.id)).toBe(true);
		const nextStop = startMemoryWorker(database, { process: async (_, context) => { captured.push([...context]); return []; } });
		try { await waitFor(() => readConversationMemories(database, chat.id).sources.find((entry) => entry.messageId === nextStory.messageId)?.status === "complete"); expect(captured[1]?.map((entry) => entry.messageId)).toEqual([guidance.messageId, story.messageId, tail.messageId]); }
		finally { await nextStop(); }
	});

	test("deletes all excluded-author collections and rewrites other Swipes without changing text or ownership", async () => {
		const chat = createChat(database);
		const writer = chat.cast[0]!;
		const maren = chat.cast[1]!;
		source(database, chat.id, 1, writer, ["Writer"]);
		source(database, chat.id, 2, writer, ["Writer"], false);
		const story = source(database, chat.id, 3, maren, ["Writer", "Maren"]);
		source(database, chat.id, 4, maren, ["Writer"], false);
		const otherChat = createChat(database);
		source(database, otherChat.id, 1, otherChat.cast[0]!, ["Writer"]);
		const before = readConversationMemories(database, chat.id).sources.find((entry) => entry.messageId === story.messageId)!;
		const response = await save(database, chat.id, writer.id, { kind: "excluded" });
		const { memories } = Value.Parse(memoryLabelsMerged, await response.json());
		expect(memories.identities).toEqual({ [writer.id]: { kind: "excluded" } });
		expect(memories.sources.map((entry) => entry.claims[0]!.people)).toEqual([["Maren"], []]);
		expect(memories.sources[0]).toEqual({ ...before, revision: 2, claims: [{ ...before.claims[0]!, people: ["Maren"] }] });
		expect(() => correctMemorySource(database, chat.id, { ...story, expectedRevision: 1, operation: "remove", index: 0 })).toThrow(StaleMemoryCollectionError);
		expect(readConversationMemories(database, otherChat.id).sources[0]?.claims[0]?.people).toEqual(["Writer"]);
		expect((await save(database, chat.id, writer.id, { kind: "themselves" })).status).toBe(200);
		expect(readConversationMemories(database, chat.id).identities).toEqual({});
		expect(readConversationMemories(database, chat.id).sources[0]).toMatchObject({ status: "unprocessed", claims: [] });
		expect((await catchup(database, chat.id)).pending).toBe(1);
	});

	test("Plays rewrites and deduplicates saved labels and corrections across participant renames", async () => {
		const chat = createChat(database);
		const writer = chat.cast[0]!;
		const story = source(database, chat.id, 1, writer, ["Writer", "Tanjs", "Maren"]);
		expect((await save(database, chat.id, writer.id, { kind: "plays", person: " Tanjs " })).status).toBe(200);
		const view = readConversationMemories(database, chat.id);
		expect(view.sources[0]?.claims[0]?.people).toEqual(["Tanjs", "Maren"]);
		expect(view.sources[0]?.revision).toBe(2);
		const corrected = correctMemorySource(database, chat.id, { ...story, expectedRevision: 2, operation: "edit", index: 0, claim: "A promise.", attribution: "Narrated event", people: ["Writer", "Tanjs"] });
		expect(corrected.claims[0]?.people).toEqual(["Tanjs"]);
		database.run("UPDATE participant SET name = 'Director' WHERE id = ?", [writer.id]);
		expect(correctMemorySource(database, chat.id, { ...story, expectedRevision: corrected.revision, operation: "edit", index: 0, claim: "A promise.", attribution: "Narrated event", people: ["Director", "Writer", "Tanjs"] }).claims[0]?.people).toEqual(["Tanjs"]);
		const next = source(database, chat.id, 2, { ...writer, name: "Director" });
		expect(queueMemorySource(database, chat.id, next.messageId)).toBe(true);
		const stop = startMemoryWorker(database, { process: async (captured) => [claim(captured.messageId, ["Director", "Tanjs", "Writer"])] });
		try { await waitFor(() => readConversationMemories(database, chat.id).sources.find((entry) => entry.messageId === next.messageId)?.status === "complete"); expect(readConversationMemories(database, chat.id).sources.find((entry) => entry.messageId === next.messageId)?.claims[0]?.people).toEqual(["Tanjs"]); }
		finally { await stop(); }
	});

	test("identities and label merges share conflicts and reject invalid names and foreign participants atomically", async () => {
		const chat = createChat(database);
		const writer = chat.cast[0]!;
		source(database, chat.id, 1, writer, ["Writer", "Maren"]);
		mergeMemoryLabels(database, chat.id, { expectedRevision: 0, labels: ["Maren"], destination: "Mary" });
		const before = readConversationMemories(database, chat.id);
		const conflict = await save(database, chat.id, writer.id, { kind: "excluded" }, 0);
		expect(conflict.status).toBe(409);
		expect(Value.Parse(memoryLabelsConflict, await conflict.json()).memories).toEqual({ ...before, cursor: expect.any(String) });
		expect((await save(database, chat.id, writer.id, { kind: "plays", person: "   " })).status).toBe(422);
		const other = createChat(database);
		expect((await save(database, chat.id, other.cast[0]!.id, { kind: "excluded" })).status).toBe(422);
		expect(readConversationMemories(database, chat.id)).toEqual({ ...before, cursor: expect.any(String) });
		expect((await save(database, chat.id, writer.id, { kind: "excluded" })).status).toBe(200);
		expect(() => mergeMemoryLabels(database, chat.id, { expectedRevision: 1, labels: ["Mary"], destination: "Maren" })).toThrow();
	});

	test("aborts excluded authors in flight and prevents late results restoring their deleted collections", async () => {
		const chat = createChat(database);
		const writer = chat.cast[0]!;
		const own = source(database, chat.id, 1, writer);
		queueMemorySource(database, chat.id, own.messageId);
		const started = Promise.withResolvers<AbortSignal>();
		const release = Promise.withResolvers<void>();
		const stop = startMemoryWorker(database, { concurrency: 1, process: async (captured, _, signal) => { started.resolve(signal); await release.promise; return [claim(captured.messageId, ["Writer"])]; } });
		try {
			const signal = await started.promise;
			expect((await save(database, chat.id, writer.id, { kind: "excluded" })).status).toBe(200);
			expect(signal.aborted).toBe(true);
			release.resolve(); await stop();
			expect(readConversationMemories(database, chat.id).sources).toEqual([]);
			await save(database, chat.id, writer.id, { kind: "themselves" });
			expect(readConversationMemories(database, chat.id).sources).toMatchObject([{ status: "unprocessed", claims: [] }]);
		} finally { release.resolve(); await stop(); }
	});

	test.each(["excluded", "plays"] as const)("applies latest %s rules to an extraction already running", async (kind) => {
		const chat = createChat(database);
		const story = source(database, chat.id, 1, chat.cast[1]!);
		queueMemorySource(database, chat.id, story.messageId);
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const stop = startMemoryWorker(database, { concurrency: 1, process: async (captured) => { started.resolve(); await release.promise; return [claim(captured.messageId, ["Writer", "Tanjs", "Maren"])]; } });
		try {
			await started.promise;
			await save(database, chat.id, chat.cast[0]!.id, kind === "plays" ? { kind, person: "Tanjs" } : { kind });
			release.resolve();
			await waitFor(() => readConversationMemories(database, chat.id).sources[0]?.status === "complete");
			expect(readConversationMemories(database, chat.id).sources[0]?.claims[0]?.people).toEqual(["Tanjs", "Maren"]);
		} finally { release.resolve(); await stop(); }
	});

	test("a cancelled extraction cannot publish into a recreated collection for the same Variant", async () => {
		const chat = createChat(database);
		const writer = chat.cast[0]!;
		const own = source(database, chat.id, 1, writer);
		queueMemorySource(database, chat.id, own.messageId);
		const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const finished = Promise.withResolvers<void>();
		let calls = 0;
		const stop = startMemoryWorker(database, { concurrency: 2, process: async (captured, _, __, trace) => {
			const index = calls++;
			started[index]!.resolve(); await release[index]!.promise;
			trace("Returned result", { claim: index === 0 ? "Old promise" : "New promise" });
			if (index === 0) finished.resolve();
			return [{ ...claim(captured.messageId, ["Writer"]), claim: index === 0 ? "Old promise" : "New promise" }];
		} });
		try {
			await started[0]!.promise;
			await save(database, chat.id, writer.id, { kind: "excluded" });
			await save(database, chat.id, writer.id, { kind: "themselves" });
			await catchup(database, chat.id);
			await started[1]!.promise;
			release[0]!.resolve(); await finished.promise;
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(readConversationMemories(database, chat.id).sources[0]).toMatchObject({ status: "running", claims: [] });
			release[1]!.resolve();
			await waitFor(() => readConversationMemories(database, chat.id).sources[0]?.status === "complete");
			expect(readConversationMemories(database, chat.id).sources[0]?.claims[0]?.claim).toBe("New promise");
		} finally { for (const gate of release) gate.resolve(); await stop(); }
	});

	test("exclusion survives merges into the excluded name and Plays honors existing label mappings", async () => {
		const chat = createChat(database);
		const writer = chat.cast[0]!;
		const story = source(database, chat.id, 1, chat.cast[1]!, ["Narrator", "Writer", "Maren"]);
		mergeMemoryLabels(database, chat.id, { expectedRevision: 0, labels: ["Narrator"], destination: "Writer" });
		await save(database, chat.id, writer.id, { kind: "excluded" });
		expect(readConversationMemories(database, chat.id).sources[0]?.claims[0]?.people).toEqual(["Maren"]);
		const updated = correctMemorySource(database, chat.id, { ...story, expectedRevision: readConversationMemories(database, chat.id).sources[0]!.revision, operation: "edit", index: 0, claim: "A promise.", attribution: "Narrated event", people: ["Narrator", "Writer", "Maren"] });
		expect(updated.claims[0]?.people).toEqual(["Maren"]);
		await save(database, chat.id, writer.id, { kind: "plays", person: "Tanjs" });
		mergeMemoryLabels(database, chat.id, { expectedRevision: 3, labels: ["Tanjs"], destination: "Tan" });
		const corrected = correctMemorySource(database, chat.id, { ...story, expectedRevision: readConversationMemories(database, chat.id).sources[0]!.revision, operation: "edit", index: 0, claim: "A promise.", attribution: "Narrated event", people: ["Narrator", "Writer", "Tanjs"] });
		expect(corrected.claims[0]?.people).toEqual(["Tan"]);
	});

	test.each([["excluded", false], ["plays", false], ["excluded", true], ["plays", true]] as const)("sends identity instructions only to extraction and enforces saved and published labels: %p", async (kind, renamed) => {
		initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(key).toString("base64") } });
		const chat = createChat(database);
		const writer = chat.cast[0]!;
		const guidance = source(database, chat.id, 1, writer);
		if (renamed) database.run("UPDATE participant SET name = 'Director' WHERE id = ?", [writer.id]);
		const nextGuidance = source(database, chat.id, 2, { ...writer, name: renamed ? "Director" : "Writer" });
		const saved = source(database, chat.id, 3, chat.cast[1]!, renamed ? ["Writer", "Director", "Tanjs", "Maren"] : ["Writer", "Tanjs", "Maren"]);
		const story = source(database, chat.id, 4, chat.cast[1]!);
		const connections = createConnectionSettingsModule(database, { masterKey: key });
		const profileId = connections.createProfile({ expectedRevision: 0, profile, credential: "fake-secret" }).profiles[0]!.id;
		const settings = createMemorySettingsModule(database);
		settings.apply({ ...settings.get(), expectedRevision: settings.get().revision, enabled: true, extractionProfileId: profileId, extractionModel: "fake-extraction" });
		configureDecisionModels(database, key);
		await save(database, chat.id, writer.id, kind === "plays" ? { kind, person: "Tanjs" } : { kind });
		expect(readConversationMemories(database, chat.id).sources.find((entry) => entry.messageId === saved.messageId)?.claims[0]?.people).toEqual(["Tanjs", "Maren"]);
		queueMemorySource(database, chat.id, story.messageId);
		const requests = { extraction: new Array<string>(), decisions: new Array<string>() };
		const stop = startMemoryWorker(database, { process: (captured, context, signal) => extractAndJudgeMemorySource(database, captured, context, async (input, init) => {
			const body = String(init?.body);
			if (String(input).endsWith("/systemone")) {
				requests.decisions.push(body);
				return Response.json({ answers: { candidate_0_support: { type: "choice", choice: "supported", probabilities: { supported: 1, contradicted: 0, not_established: 0 } }, candidate_0_attribution: { type: "choice", choice: "correct", probabilities: { correct: 1, misattributed: 0, unclear: 0 } }, candidate_0_usefulness: { type: "choice", choice: "retain", probabilities: { retain: 1, omit: 0 } } } });
			}
			requests.extraction.push(body);
			const content = JSON.stringify({ candidates: [{ claim: "Maren promised a key.", attribution: "Narrated event", people: renamed ? ["Writer", "Director", "Tanjs", "Maren"] : ["Writer", "Tanjs", "Maren"], evidence: [{ messageId: captured.messageId, excerpt: captured.content }] }] });
			return new Response([{ choices: [{ index: 0, delta: { content }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
		}, signal) });
		try {
			await waitFor(() => readConversationMemories(database, chat.id).sources.find((entry) => entry.messageId === story.messageId)?.status === "complete");
			const sentence = renamed ? kind === "excluded" ? "Director (also Writer) directs the story and is not a character in it. Never use Director or Writer as a person." : "First person in Director's (also Writer's) Messages refers to Tanjs." : kind === "excluded" ? "Writer directs the story and is not a character in it. Never use Writer as a person." : "First person in Writer's Messages refers to Tanjs.";
			expect(requests.extraction).toHaveLength(1);
			expect(requests.extraction[0]).toContain(sentence);
			expect(requests.decisions).toHaveLength(1);
			expect(requests.decisions[0]).not.toContain(sentence);
			expect(requests.decisions[0]).not.toContain("(also ");
			expect(JSON.parse(requests.decisions[0]!).state.context.slice(0, 2)).toMatchObject([{ messageId: guidance.messageId, speaker: "Writer" }, { messageId: nextGuidance.messageId, speaker: renamed ? "Director" : "Writer" }]);
			expect(readConversationMemories(database, chat.id).sources.find((entry) => entry.messageId === story.messageId)?.claims[0]?.people).toEqual(["Tanjs", "Maren"]);
		} finally { await stop(); }
	});
});
