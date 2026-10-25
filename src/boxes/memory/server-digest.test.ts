import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openObservedDatabase } from "../../server/test-fixtures/conversation";
import { initializeConnectionSecretKey } from "../../server/connection-secrets";
import { createConnectionSettingsModule } from "../../server/connection-settings";
import { configureDecisionModels } from "../../server/contract/decision-model-test-fixtures";
import { configureEmbeddings, createChat, key, profile } from "../../server/contract/prompt-preset-test-fixtures";
import { digestNow } from "../../server/test-fixtures/digest";
import { applyBoxDecisionSettings, readBoxDecisionSettings } from "../../server/box/decision-settings";
import { readCachedVectors } from "../../server/box/embedding";
import type { ModelFetch } from "../../server/model-client";
import { formatImageReference } from "../../shared/image-reference";
import { memoryRecord } from "./contract";
import { readConversationMemories, setMemoryIdentity, setMemoryNote } from "./server-memories";
import { readMemoryChatSettings } from "./server-chat";
import { createMemorySettingsModule, readMemoryEmbedding } from "./server-settings";

type Calls = { extraction: string[]; decisions: string[]; embeddings: { url: string; model: string; input: string[]; authorization: string | null }[] };

// SAFETY: the extraction fake receives the model client's Chat Completions request body.
const promptOf = (body: string) => (JSON.parse(body) as { messages: { content: string }[] }).messages.map(({ content }) => content).join("");
const capturedOf = (body: string) => {
	const prompt = promptOf(body);
	// SAFETY: the extraction prompt ends with the captured messages as one JSON object.
	return JSON.parse(prompt.slice(prompt.indexOf("{", prompt.indexOf("Captured source and reference context:")))) as { source: { messageId: number; content: string }; precedingSelectedMessages: { messageId: number; content: string }[] };
};

const completion = (content: string, finish = "stop") => new Response(
	[{ choices: [{ index: 0, delta: { content }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: finish }] }].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
	{ headers: { "content-type": "text/event-stream" } },
);

// @approved
//  One fake provider: extraction proposes one claim citing the whole source,
//  the Decision Model supports and keeps every candidate with `retain`
//  probability, and embeddings answer one vector per text.
const provider = (calls: Calls, { retain = 1, finish = "stop", claim = "Maren promised a key." } = {}): ModelFetch => async (input, init) => {
	const url = String(input);
	const body = String(init?.body);
	if (url.endsWith("/systemone")) {
		calls.decisions.push(body);
		// SAFETY: the Decision Model request carries its questions by id.
		const { questions } = JSON.parse(body) as { questions: object };
		const answer = (id: string) => id.endsWith("_support") ? { type: "choice", choice: "supported", probabilities: { supported: 1, contradicted: 0, not_established: 0 } }
			: id.endsWith("_attribution") ? { type: "choice", choice: "correct", probabilities: { correct: 1, misattributed: 0, unclear: 0 } }
			: { type: "choice", choice: "retain", probabilities: { retain, omit: 1 - retain } };
		return Response.json({ answers: Object.fromEntries(Object.keys(questions).map((id) => [id, answer(id)])) });
	}
	if (url.endsWith("/embeddings")) {
		// SAFETY: the embedding request carries the model and its text batch.
		const request = JSON.parse(body) as { model: string; input: string[] };
		calls.embeddings.push({ url, model: request.model, input: request.input, authorization: new Headers(init?.headers).get("authorization") });
		return Response.json({ data: request.input.map(() => ({ embedding: [1, 0] })) });
	}
	calls.extraction.push(body);
	const { source } = capturedOf(body);
	return completion(JSON.stringify({ candidates: [{ claim, attribution: "Narrated event", people: ["Maren"], evidence: [{ messageId: source.messageId, excerpt: source.content }] }] }), finish);
};

describe("Memory's digest", () => {
	let database: Database;
	let chat: ReturnType<typeof createChat>;
	let calls: Calls;
	beforeEach(() => {
		database = openObservedDatabase();
		initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(key).toString("base64") } });
		chat = createChat(database);
		const profileId = createConnectionSettingsModule(database, { masterKey: key }).createProfile({ expectedRevision: 0, profile, credential: "fake-secret" }).profiles[0]!.id;
		const settings = createMemorySettingsModule(database);
		settings.apply({ ...settings.get(), expectedRevision: settings.get().revision, extractionProfileId: profileId, extractionModel: "fake-extraction" });
		configureDecisionModels(database, key);
		calls = { extraction: [], decisions: [], embeddings: [] };
	});
	afterEach(() => database.close());

	const passage = (position: number, content: string, author: { id: number; name: string } = chat.cast[1]!) => {
		const message = database.query<{ id: number }, [number, number, number, string]>("INSERT INTO messages (conversation_id, position, timestamp, author_participant_id, author_name) VALUES (?, ?, '2026-10-07T00:00:00Z', ?, ?) RETURNING id").get(chat.id, position, author.id, author.name)!;
		const variant = database.query<{ id: number }, [number, string]>("INSERT INTO message_variant (message_id, position, content, timestamp, selected) VALUES (?, 0, ?, '2026-10-07T00:00:00Z', 1) RETURNING id").get(message.id, content)!;
		return { messageId: message.id, variantId: variant.id };
	};
	const digest = (variantId: number, fetch: ModelFetch) => digestNow(database, chat.id, "memory", memoryRecord, variantId, fetch);

	test.each([{ minimum: 0.3, kept: 1 }, { minimum: 0.9, kept: 0 }])("keeps claims whose retain probability meets the $minimum minimum", async ({ minimum, kept }) => {
		const settings = createMemorySettingsModule(database);
		settings.apply({ ...settings.get(), expectedRevision: settings.get().revision, retainProbabilityMinimum: minimum });
		const story = passage(1, "Maren promised Writer the brass key.");
		const record = await digest(story.variantId, provider(calls, { retain: 0.8 }));
		expect(record?.automatic?.claims).toMatchObject([{ claim: "Maren promised a key.", evidence: [{ messageId: story.messageId, excerpt: "Maren promised Writer the brass key." }], judgment: { usefulness: "retain", probabilities: { "usefulness:retain": 0.8 } } }].slice(0, kept));
		expect(JSON.parse(calls.decisions[0]!).questions).toHaveProperty("candidate_0_usefulness");
	});

	test("an extraction that does not finish fails the digest without claims", async () => {
		const story = passage(1, "A valid but incomplete response.");
		const record = await digest(story.variantId, provider(calls, { finish: "other" }));
		expect(record?.automatic).toBeUndefined();
		expect(record?.error?.message).toContain("did not finish successfully");
		expect(calls.decisions).toEqual([]);
	});

	test("drops the oldest preceding Messages until the source fits the extraction context", async () => {
		const settings = createMemorySettingsModule(database);
		settings.apply({ ...settings.get(), expectedRevision: settings.get().revision, contextLimit: 1000, outputReserve: 100, safetyAllowance: 0 });
		passage(1, "Oldest context. ".repeat(250));
		passage(2, "Recent context.");
		const story = passage(3, "Owning source.");
		expect((await digest(story.variantId, provider(calls)))?.error).toBeUndefined();
		expect(capturedOf(calls.extraction[0]!).precedingSelectedMessages.map(({ content }) => content)).toEqual(["Recent context."]);
	});

	test("drops the oldest preceding Messages until the passage fits the Decision Model's state limit", async () => {
		const { revision, ...selection } = readBoxDecisionSettings(database, "memory");
		applyBoxDecisionSettings(database, "memory", { type: "apply", expectedRevision: revision, ...selection, decisionStateTokenLimit: 256 });
		passage(1, "Older context. ".repeat(150));
		passage(2, "Recent context.");
		const story = passage(3, "Owning source.");
		expect((await digest(story.variantId, provider(calls)))?.error).toBeUndefined();
		expect(capturedOf(calls.extraction[0]!).precedingSelectedMessages.map(({ content }) => content)).toEqual(["Recent context."]);
		expect(JSON.parse(calls.decisions[0]!).state.context.map(({ content }: { content: string }) => content)).toEqual(["Recent context."]);
	});

	test("a passage by an author who is not in the story holds no Memories and costs no request, yet stays context", async () => {
		const writer = chat.cast[0]!;
		const guidance = passage(1, "Make Maren promise the key.", writer);
		setMemoryIdentity(database, chat.id, { expectedRevision: readConversationMemories(database, chat.id).labelRevision, participantId: writer.id, identity: { kind: "excluded" } });
		expect((await digest(guidance.variantId, provider(calls)))?.automatic).toEqual({ claims: [] });
		expect(calls).toEqual({ extraction: [], decisions: [], embeddings: [] });
		const story = passage(2, "Maren promised a key.");
		await digest(story.variantId, provider(calls));
		expect(capturedOf(calls.extraction[0]!).precedingSelectedMessages).toMatchObject([{ messageId: guidance.messageId, content: "Make Maren promise the key." }]);
	});

	test.each([["excluded", false], ["plays", false], ["excluded", true], ["plays", true]] as const)("sends identity sentences only to extraction: %p, renamed %p", async (kind, renamed) => {
		const writer = chat.cast[0]!;
		passage(1, "Writer's first word.", writer);
		if (renamed) database.run("UPDATE participant SET name = 'Director' WHERE id = ?", [writer.id]);
		passage(2, "Writer's second word.", { ...writer, name: renamed ? "Director" : "Writer" });
		const story = passage(3, "Maren promised a key.");
		setMemoryIdentity(database, chat.id, { expectedRevision: readConversationMemories(database, chat.id).labelRevision, participantId: writer.id, identity: kind === "plays" ? { kind, person: "Tanjs" } : { kind } });
		await digest(story.variantId, provider(calls));
		const sentence = renamed
			? kind === "excluded" ? "Director (also Writer) directs the story and is not a character in it. Never use Director or Writer as a person." : "First person in Director's (also Writer's) Messages refers to Tanjs."
			: kind === "excluded" ? "Writer directs the story and is not a character in it. Never use Writer as a person." : "First person in Writer's Messages refers to Tanjs.";
		expect(promptOf(calls.extraction[0]!)).toContain(sentence);
		expect(calls.decisions[0]).not.toContain(sentence);
		expect(JSON.parse(calls.decisions[0]!).state.context.map(({ speaker }: { speaker: string }) => speaker)).toEqual(["Writer", renamed ? "Director" : "Writer"]);
	});

	test("the Chat note follows the identity sentences in extraction only", async () => {
		const guidance = "\"Trainer\" in narration means Tanjs. Track injuries and promises closely.";
		const first = passage(1, "Maren promised a key.");
		await digest(first.variantId, provider(calls));
		setMemoryIdentity(database, chat.id, { expectedRevision: readConversationMemories(database, chat.id).labelRevision, participantId: chat.cast[1]!.id, identity: { kind: "plays", person: "Tanjs" } });
		setMemoryNote(database, chat.id, readMemoryChatSettings(database, chat.id).revision, guidance);
		const second = passage(2, "Maren kept the key.");
		await digest(second.variantId, provider(calls));
		expect(promptOf(calls.extraction[0]!)).not.toContain("Chat note (guidance only");
		expect(promptOf(calls.extraction[1]!)).toContain(`First person in Maren's Messages refers to Tanjs.\n\nChat note (guidance only, never a source of facts):\n${guidance}\n\nCaptured source and reference context:`);
		for (const body of calls.decisions) expect(body).not.toContain(guidance);
	});

	test("embeds the claims it keeps once, at the chosen embedding connection", async () => {
		const settings = createMemorySettingsModule(database);
		settings.apply({ ...settings.get(), expectedRevision: settings.get().revision, embeddingProfileId: configureEmbeddings(database, "http://embedding.test/v1/embeddings"), embeddingModel: "memory-v1" });
		const first = passage(1, "Maren returned Writer's key.");
		const second = passage(2, "Writer kept the key safe.");
		await digest(first.variantId, provider(calls, { claim: "Maren carries Writer's key." }));
		await digest(second.variantId, provider(calls, { claim: "Maren carries Writer's key." }));
		const text = "Maren carries Writer's key. (attribution: Narrated event)";
		expect(calls.embeddings).toEqual([{ url: "http://embedding.test/v1/embeddings", model: "memory-v1", input: [text], authorization: "Bearer embedding-secret" }]);
		expect(readCachedVectors(database, readMemoryEmbedding(database)!.spaceKey, [text]).get(text)).toEqual(Float32Array.from([1, 0]));
	});

	test("extraction reads Images only as Image Anchors, never their hash", async () => {
		const token = formatImageReference("the map", "d".repeat(64));
		passage(1, `Writer unrolled ${token}.`, chat.cast[0]!);
		const story = passage(2, `Maren studied ${token} closely.`);
		await digest(story.variantId, async (input, init) => {
			if (String(input).endsWith("/systemone")) return provider(calls)(input, init);
			calls.extraction.push(String(init?.body));
			return completion(JSON.stringify({ candidates: [] }));
		});
		const captured = capturedOf(calls.extraction[0]!);
		expect([captured.source.content, ...captured.precedingSelectedMessages.map(({ content }) => content)]).toEqual(["Maren studied [Image: the map] closely.", "Writer unrolled [Image: the map]."]);
		expect(calls.extraction[0]).not.toContain("d".repeat(64));
	});

});
