import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Value } from "@sinclair/typebox/value";
import { openInitializedDatabase } from "../database/database";
import { messageTable, messageVariantTable } from "../database/schema";
import { createChat, key, profile } from "./prompt-preset-test-fixtures";
import { createMemoryRoutes } from "./memory";
import { queueMemorySource, readConversationMemories, resetAndReextractMemorySource, startMemoryWorker } from "../memory/collections";
import { setMemoryIdentity } from "../memory/label-commands";
import { extractAndJudgeMemorySource } from "../memory/extraction";
import { createConnectionSettingsModule } from "../connection-settings";
import { initializeConnectionSecretKey } from "../connection-secrets";
import { createMemorySettingsModule } from "../memory/settings";
import { configureDecisionModels } from "./decision-model-test-fixtures";
import { conversationMemoryAllowance, conversationMemoryAllowanceApplied, conversationMemoryAllowanceConflict } from "../../shared/contract/memory";

const guidance = "\"Trainer\" in narration means Tanjs. Track injuries and promises closely.";

const saveNote = (database: Database, conversationId: number, expectedRevision: number, note: string) =>
	createMemoryRoutes(database).handle(new Request(`http://localhost/api/conversations/${conversationId}/memory-note`, { method: "POST",
		headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision, note }) }));

const saveAllowance = (database: Database, conversationId: number, expectedRevision: number, allowance: number) =>
	createMemoryRoutes(database).handle(new Request(`http://localhost/api/conversations/${conversationId}/memory-allowance`, { method: "POST",
		headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision, allowance }) }));

const source = (database: Database, conversationId: number, position: number, author: { id: number; name: string }) => {
	const db = drizzle(database);
	const message = db.insert(messageTable).values({ conversation_id: conversationId, position, timestamp: "2026-10-07T00:00:00Z",
		author_participant_id: author.id, author_name: author.name }).returning().get();
	const variant = db.insert(messageVariantTable).values({ message_id: message.id, position: 0, timestamp: message.timestamp, content: "I promised a key.", selected: true }).returning().get();
	return { messageId: message.id, variantId: variant.id };
};

const enableMemory = (database: Database) => {
	initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(key).toString("base64") } });
	const connections = createConnectionSettingsModule(database, { masterKey: key });
	const profileId = connections.createProfile({ expectedRevision: 0, profile, credential: "fake-secret" }).profiles[0]!.id;
	const settings = createMemorySettingsModule(database);
	settings.apply({ ...settings.get(), expectedRevision: settings.get().revision, enabled: true, extractionProfileId: profileId, extractionModel: "fake-extraction" });
	configureDecisionModels(database, key);
};

const waitFor = async (check: () => boolean) => {
	const deadline = Date.now() + 4000;
	while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	expect(check()).toBe(true);
};

// SAFETY: the extraction fake receives the model client's Chat Completions request body.
const promptOf = (body: string) => (JSON.parse(body) as { messages: { content: string }[] }).messages.map(({ content }) => content).join("");

describe("Conversation Memory note", () => {
	let database: Database;
	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("saves a trimmed note against the shared settings revision and rejects stale and oversized commands", async () => {
		const chat = createChat(database);
		const routes = createMemoryRoutes(database);
		const read = await routes.handle(new Request(`http://localhost/api/conversations/${chat.id}/memory-allowance`));
		expect(Value.Parse(conversationMemoryAllowance, await read.json())).toEqual({ revision: 0, allowance: 2048, note: "", enabled: true });

		const saved = await saveNote(database, chat.id, 0, `  ${guidance}  `);
		expect(saved.status).toBe(200);
		expect(Value.Parse(conversationMemoryAllowanceApplied, await saved.json())).toMatchObject({ outcome: "applied", settings: { revision: 1, note: guidance, allowance: 2048, enabled: true } });

		const stale = await saveNote(database, chat.id, 0, "The second writer's note.");
		expect(stale.status).toBe(409);
		expect(Value.Parse(conversationMemoryAllowanceConflict, await stale.json())).toMatchObject({ outcome: "conflict", expectedRevision: 0,
			actualRevision: 1, currentSettings: { revision: 1, note: guidance } });

		const oversized = await saveNote(database, chat.id, 1, "x".repeat(2_001));
		expect(oversized.status).toBe(422);
		expect(await oversized.text()).toContain("2,000 characters");

		const allowance = await saveAllowance(database, chat.id, 1, 100);
		expect(allowance.status).toBe(200);
		expect(Value.Parse(conversationMemoryAllowanceApplied, await allowance.json())).toMatchObject({ outcome: "applied", settings: { revision: 2, allowance: 100, note: guidance } });

		const cleared = await saveNote(database, chat.id, 2, "   ");
		expect(cleared.status).toBe(200);
		expect(Value.Parse(conversationMemoryAllowanceApplied, await cleared.json())).toMatchObject({ outcome: "applied", settings: { revision: 3, note: "" } });
	});

	test("appends the note after the identity sentences in extraction only, and an empty note leaves the prompt unchanged", async () => {
		enableMemory(database);
		const chat = createChat(database);
		const story = source(database, chat.id, 1, chat.cast[1]!);
		const requests = { extraction: new Array<string>(), decisions: new Array<string>() };
		const stop = startMemoryWorker(database, { process: (captured, context, signal) => extractAndJudgeMemorySource(database, captured, context, async (input, init) => {
			const body = String(init?.body);
			if (String(input).endsWith("/systemone")) {
				requests.decisions.push(body);
				return Response.json({ answers: { candidate_0_support: { type: "choice", choice: "supported", probabilities: { supported: 1, contradicted: 0,
					not_established: 0 } }, candidate_0_attribution: { type: "choice", choice: "correct", probabilities: { correct: 1, misattributed: 0,
					unclear: 0 } }, candidate_0_usefulness: { type: "choice", choice: "retain", probabilities: { retain: 1, omit: 0 } } } });
			}
			requests.extraction.push(body);
			const content = JSON.stringify({ candidates: [{ claim: "Maren promised a key.", attribution: "Narrated event", people: ["Maren"],
				evidence: [{ messageId: captured.messageId, excerpt: captured.content }] }] });
			return new Response([{ choices: [{ index: 0, delta: { content }, finish_reason: null }] }, { choices: [{ index: 0, delta: {},
				finish_reason: "stop" }] }].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
				{ headers: { "content-type": "text/event-stream" } });
		}, signal) });
		const reextract = async (expectedPrompts: number) => {
			const target = readConversationMemories(database, chat.id).sources[0]!;
			resetAndReextractMemorySource(database, chat.id, target.messageId, target.variantId, target.revision);
			await waitFor(() => requests.extraction.length === expectedPrompts && readConversationMemories(database, chat.id).sources[0]?.status === "complete");
		};
		try {
			expect(queueMemorySource(database, chat.id, story.messageId)).toBe(true);
			await waitFor(() => readConversationMemories(database, chat.id).sources[0]?.status === "complete");
			setMemoryIdentity(database, chat.id, { expectedRevision: readConversationMemories(database, chat.id).labelRevision, participantId: chat.cast[1]!.id, identity: { kind: "plays", person: "Tanjs" } });
			expect((await saveNote(database, chat.id, 0, guidance)).status).toBe(200);
			expect(readConversationMemories(database, chat.id).sources[0]).toMatchObject({ status: "complete", claims: [{ claim: "Maren promised a key." }] });
			await reextract(2);
			setMemoryIdentity(database, chat.id, { expectedRevision: readConversationMemories(database, chat.id).labelRevision, participantId: chat.cast[1]!.id, identity: { kind: "themselves" } });
			expect((await saveNote(database, chat.id, 1, "")).status).toBe(200);
			await reextract(3);

			expect(requests.extraction).toHaveLength(3);
			expect(promptOf(requests.extraction[1]!))
				.toContain(
				`First person in Maren's Messages refers to Tanjs.\n\nChat note (guidance only, never a source of facts):\n${guidance}\n\nCaptured source and reference context:`);
			expect(promptOf(requests.extraction[0]!)).not.toContain("Chat note (guidance only");
			expect(promptOf(requests.extraction[2]!)).toBe(promptOf(requests.extraction[0]!));
			expect(requests.decisions).toHaveLength(3);
			for (const body of requests.decisions) expect(body).not.toContain(guidance);
		} finally { await stop(); }
	});
});
