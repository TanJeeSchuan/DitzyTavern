import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { boxDescriptor, DEFAULT_BOX_DELEGATE } from "../../shared/contract/box";
import { emptyPromptChannels } from "../../shared/definition";
import { initializeConnectionSecretKey } from "../../server/connection-secrets";
import { createConnectionSettingsModule } from "../../server/connection-settings";
import { key, profile } from "../../server/contract/prompt-preset-test-fixtures";
import { createConversationWithHistory } from "../../server/test-fixtures/conversation";
import { formatImageReference } from "../../shared/image-reference";
import { openInitializedDatabase } from "../../server/database/database";
import { messageTable, messageVariantTable } from "../../server/database/schema";
import { boxExports } from "../../server/box/exports";
import { applyBoxDelegateSettings, readBoxDelegateSettings } from "../../server/box/delegate-settings";
import { writeAutomaticRecord, writeWriterRecord } from "../../server/box/records";
import { readBoxLifecycles } from "../../server/box/setup";
import type { CodeAgentActivity } from "@/box-sdk/server";
import type { CharacterDraft, DraftMessages } from "./contract";
import { draftPerson, draftRefusal, readDrafter } from "./server-draft";

const messages: DraftMessages = [
	{ id: 7, index: 0, author: "Maren", authorParticipantId: 1, text: "Maren pours. \"Another round, then.\"" },
	{ id: 9, index: 1, author: "Bob", authorParticipantId: 2, text: "\"Mind the glass,\" Bob says. \"It was my mother's.\"" },
	{ id: 11, index: 2, author: "Bob", authorParticipantId: 2, text: "Bob nods. <thought >I broke it myself.</thought> \"It held up.\" <thought>unfinished" },
];
const draft = (quotes: CharacterDraft["quotes"], exampleDialogue: string): CharacterDraft =>
	({ name: "Bartholomew Crane", prompt: { ...emptyPromptChannels(), exampleDialogue }, quotes });

test("a draft whose example dialogue is made of quotes copied from the path is accepted", () => {
	const quotes = [{ messageId: 9, text: "\"Mind the glass,\"" }, { messageId: 9, text: "\"It was my mother's.\"" }];
	expect(draftRefusal(messages, draft(quotes, "\"Mind the glass,\"\n\n  \"It was my mother's.\"  "))).toBeUndefined();
});

test("a quote that is not word for word in its Message is refused", () => {
	expect(draftRefusal(messages, draft([{ messageId: 9, text: "\"Mind the glasses,\"" }], ""))).toBe("The quote \"\"Mind the glasses,\"\" is not in Message 9 word for word.");
});

test("a quote copied from another Message than the one it names is refused", () => {
	expect(draftRefusal(messages, draft([{ messageId: 7, text: "\"Mind the glass,\"" }], ""))).toBe("The quote \"\"Mind the glass,\"\" is not in Message 7 word for word.");
});

test("a quote naming a Message off the path is refused", () => {
	expect(draftRefusal(messages, draft([{ messageId: 8, text: "Another round" }], ""))).toBe("Message 8 is not on the story's path.");
});

test("an example dialogue line that is not one of the quotes is refused", () => {
	const refusal = draftRefusal(messages, draft([{ messageId: 9, text: "\"Mind the glass,\"" }], "\"Mind the glass,\"\n\"I never liked that glass.\""));
	expect(refusal).toBe("The exampleDialogue line \"\"I never liked that glass.\"\" is not one of the quotes; every line must be a quote's text.");
});

test("a quote from inside a thought is refused, and one beside a thought or after an unclosed one is not", () => {
	const refusal = draftRefusal(messages, draft([{ messageId: 11, text: "I broke it myself." }], ""));
	expect(refusal).toContain("inside a <thought> in Message 11");
	expect(draftRefusal(messages, draft([{ messageId: 11, text: "\"It held up.\"" }, { messageId: 11, text: "<thought>unfinished" }], ""))).toBeUndefined();
});

test("a draft with an Image Reference in Appearance is refused", () => {
	const proposed = draft([], "");
	proposed.prompt.appearance = formatImageReference("Bob", "a".repeat(64));
	expect(draftRefusal(messages, proposed)).toContain("Appearance must be text only.");
});

// @approved
//  The agent's model, a localhost fake speaking Chat Completions: each
// request takes the next scripted tool call, and `onRequest` runs before it
// answers, so a test can change the story while the run is under way.
const replies: { readonly name: string; readonly arguments: string }[] = [];
let requests = 0;
let onRequest = () => {};
/** @approved One streamed completion that calls one tool, as Chat Completions frames it. */
const toolCallStream = (name: string, input: string, id: string) => {
	const frame = (choice: { delta: { role?: string; tool_calls?: unknown[] }; finish_reason: string | null }) =>
		`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: "stage-1", choices: [{ index: 0, ...choice }] })}\n\n`;
	const call = { index: 0, id, type: "function", function: { name, arguments: input } };
	return `${frame({ delta: { role: "assistant", tool_calls: [call] }, finish_reason: null })}${frame({ delta: {}, finish_reason: "tool_calls" })}data: [DONE]\n\n`;
};
const model = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
	requests += 1;
	onRequest();
	const reply = replies.shift();
	if (reply === undefined) return new Response("No reply scripted.", { status: 500 });
	return new Response(toolCallStream(reply.name, reply.arguments, `call_${requests}`), { headers: { "content-type": "text/event-stream" } });
} });
afterAll(async () => { await model.stop(true); });

let database: Database;
beforeEach(() => {
	initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(key).toString("base64") } });
	database = openInitializedDatabase({ path: ":memory:" });
	replies.length = 0;
	onRequest = () => {};
	const connections = createConnectionSettingsModule(database, { masterKey: key });
	const stage = { ...profile, displayName: "Stage", requestUrl: `http://127.0.0.1:${model.port}/v1/` };
	const profileId = connections.createProfile({ expectedRevision: connections.get().revision, profile: stage, credential: "stage-secret" })
		.profiles.find(({ displayName }) => displayName === "Stage")!.id; // @approved The profile was just created.
	applyBoxDelegateSettings(database, DEFAULT_BOX_DELEGATE, { type: "apply", expectedRevision: readBoxDelegateSettings(database, DEFAULT_BOX_DELEGATE).revision, profileId, model: "stage-1" });
});
afterEach(() => database.close());

test("the Drafter does not read Exports for a missing Chat", () => {
	expect(readDrafter(database, -1, () => { throw new Error("Read Exports for a missing Chat"); })).toBeUndefined();
});

/** @approved One Memory record holding a single kept Claim about Bob. */
const bobClaim = (messageId: number, claim: string) => ({ claims: [{
	claim, attribution: "Maren said it.", people: ["Bob"], evidence: [{ messageId, excerpt: "Bob minds the glass." }],
	judgment: { support: "supported", attribution: "correct", usefulness: "retain", probabilities: {}, confidence: { support: 1, attribution: 1, usefulness: 1 } },
}] });

test("the agent reads Memory as it was when the draft started, not as a change made during the run left it", async () => {
	const chat = createConversationWithHistory(database, { name: "Drafting Bob" });
	const db = drizzle(database);
	const message = db.insert(messageTable).values({ conversation_id: chat.id, position: 1, timestamp: "2026-11-19T00:00:00Z", author_name: null, author_participant_id: null }).returning().get().id;
	const variant = db.insert(messageVariantTable).values({ message_id: message, position: 0, timestamp: "2026-11-19T00:00:00Z", content: "Bob minds the glass.", selected: true }).returning().get().id;
	const memory = readBoxLifecycles(db, chat.id).memory!.instance; // @approved Memory starts enabled in every new Chat.
	writeAutomaticRecord(db, boxDescriptor("memory"), memory, variant, bobClaim(message, "Bob keeps the glass."), "source");
	onRequest = () => {
		onRequest = () => {};
		writeWriterRecord(db, boxDescriptor("memory"), memory, variant, bobClaim(message, "Bob broke the glass."));
	};
	replies.push(
		{ name: "run", arguments: JSON.stringify({ code: "[memory.people, memory.claims.Bob.map((found) => found.claim)]" }) },
		{ name: "submit", arguments: JSON.stringify({ draft: { name: "Bob", prompt: emptyPromptChannels(), quotes: [] } }) },
	);
	const activities: CodeAgentActivity[] = [];
	expect(await draftPerson(database, boxExports(database, chat.id), { conversationId: chat.id, person: "Bob" }, new AbortController().signal, (activity) => activities.push(activity)))
		.toEqual({ name: "Bob", prompt: emptyPromptChannels(), quotes: [] });
	expect(boxExports(database, chat.id).memory?.selectedClaims?.()).toMatchObject([{ claim: "Bob broke the glass." }]);
	expect(activities.map(({ output }) => output)).toEqual(['Returned:\n[["Bob"],["Bob keeps the glass."]]']);
});
