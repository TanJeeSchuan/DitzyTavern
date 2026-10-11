import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { initializeConnectionSecretKey } from "../connection-secrets";
import { configureDecisionModels } from "../contract/decision-model-test-fixtures";
import type { ModelFetch } from "../model-client/types";
import { createConversationWithHistory, insertBox, openObservedDatabase } from "../test-fixtures/conversation";
import { applyBoxDecisionSettings } from "./decision-settings";
import { cancelBoxCatchUp, queueBoxDigests, readBoxCatchUp, startBoxCatchUp, startBoxDigests } from "./digest";
import { readRecordSlots } from "./records";

const prompt = { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" };
const masterKey = new Uint8Array(32).fill(3);

interface StubQuestion { readonly criteria?: Readonly<Record<string, string>> }
interface StubDecisionRequest { readonly questions: Readonly<Record<string, StubQuestion>> }

const decisionResponse = (request: StubDecisionRequest): Response => {
	const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
		const options = Object.keys(question.criteria ?? {});
		const choice = id === "elapsed" ? "overnight" : "storm";
		return [id, { type: "choice", choice, probabilities: Object.fromEntries(options.map((option) => [option, option === choice ? 0.9 : 0.1 / (options.length - 1)])) }];
	}));
	return Response.json({ answers });
};

// @approved
//  A controllable Decision Model stub: every request parks until the test
//  releases it, so worker ordering, progress and cancellation are observable.
const heldDecisionFetch = () => {
	const releases: (() => void)[] = [];
	const contents: string[] = [];
	return {
		fetch: ((_input, init) => new Promise<Response>((resolve) => {
			const request: StubDecisionRequest = JSON.parse(String(init?.body));
			contents.push(String(init?.body));
			releases.push(() => resolve(decisionResponse(request)));
		})) satisfies ModelFetch,
		release: () => { releases.shift()?.(); },
		pending: () => releases.length,
		contents: () => contents,
	};
};

let database: Database;
let stopDigests: (() => Promise<void>) | undefined;
beforeEach(() => {
	database = openObservedDatabase();
	initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(masterKey).toString("base64") } });
});
afterEach(async () => {
	await stopDigests?.();
	stopDigests = undefined;
	database.close();
});

const createChat = () => createConversationWithHistory(database, {
	name: "Clock Chat",
	participants: [
		{ definition: { name: "Writer", prompt, openings: [] } },
		{ definition: { name: "Maren", prompt, openings: [] } },
	],
	control: { human: 0, model: 1 },
});

const addPassage = (conversationId: number, position: number, content: string): number => {
	const message = database.query<{ id: number }, [number, number]>("INSERT INTO messages (conversation_id, position, timestamp) VALUES (?, ?, '2026-01-01') RETURNING id").get(conversationId, position);
	if (message === null) throw new Error("The test Message was not inserted.");
	const variant = database.query<{ id: number }, [number, string]>(
		"INSERT INTO message_variant (message_id, position, content, timestamp, selected) VALUES (?, 0, ?, '2026-01-01', 1) RETURNING id",
	).get(message.id, content);
	if (variant === null) throw new Error("The test Variant was not inserted.");
	return variant.id;
};

const enableDecision = () => {
	const selection = configureDecisionModels(database, masterKey);
	applyBoxDecisionSettings(database, "world-clock", { type: "apply", expectedRevision: 0, ...selection });
};

const waitFor = async (condition: () => boolean): Promise<void> => {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (condition()) return;
		await Bun.sleep(1);
	}
	throw new Error("The condition never became true.");
};

test("catch-up digests every selected Variant without a record and reports its progress", async () => {
	const chat = createChat();
	const first = addPassage(chat.id, 1, "The storm breaks over the tower.");
	const second = addPassage(chat.id, 2, "Snow drifts against the shutters.");
	const clock = insertBox(database, chat.id, "world-clock");
	enableDecision();
	const stub = heldDecisionFetch();
	stopDigests = startBoxDigests(database, { fetch: stub.fetch });

	startBoxCatchUp(database, chat.id);
	expect(readBoxCatchUp(database, chat.id)).toEqual({ total: 2, remaining: 2 });
	await waitFor(() => stub.pending() === 2);
	stub.release();
	await waitFor(() => readBoxCatchUp(database, chat.id)?.remaining === 1);
	stub.release();
	await waitFor(() => readBoxCatchUp(database, chat.id) === null);

	const records = readRecordSlots(drizzle(database), "world-clock", clock, [first, second]);
	for (const variantId of [first, second]) {
		const record = records.get(variantId)?.automatic;
		expect(record?.weather).toBe("storm");
		expect(record?.minutes).toBeGreaterThanOrEqual(540);
		expect(record?.minutes).toBeLessThanOrEqual(720);
	}
});

test("cancelling a catch-up run discards its in-flight results", async () => {
	const chat = createChat();
	const passage = addPassage(chat.id, 1, "The storm breaks over the tower.");
	const clock = insertBox(database, chat.id, "world-clock");
	enableDecision();
	const stub = heldDecisionFetch();
	stopDigests = startBoxDigests(database, { fetch: stub.fetch });

	startBoxCatchUp(database, chat.id);
	await waitFor(() => stub.pending() === 1);
	cancelBoxCatchUp(database, chat.id);
	expect(readBoxCatchUp(database, chat.id)).toBeNull();
	stub.release();
	await stopDigests();
	stopDigests = undefined;
	expect(readRecordSlots(drizzle(database), "world-clock", clock, [passage]).size).toBe(0);
});

test("a clock that stops running abandons its in-flight digest, even when it is enabled again before the result lands", async () => {
	const chat = createChat();
	const passage = addPassage(chat.id, 1, "The storm breaks over the tower.");
	const clock = insertBox(database, chat.id, "world-clock");
	enableDecision();
	const stub = heldDecisionFetch();
	stopDigests = startBoxDigests(database, { fetch: stub.fetch });

	queueBoxDigests(database, { conversationId: chat.id, touchedVariantIds: [passage], removedVariantIds: [] });
	await waitFor(() => stub.pending() === 1);
	queueBoxDigests(database, { conversationId: chat.id, touchedVariantIds: [], removedVariantIds: [], stoppedBox: "world-clock" });
	stub.release();
	await stopDigests();
	stopDigests = undefined;
	expect(readRecordSlots(drizzle(database), "world-clock", clock, [passage]).size).toBe(0);
});

test("a cancelled run can be restarted for the same Variants before the aborted job settles", async () => {
	const chat = createChat();
	const passage = addPassage(chat.id, 1, "The storm breaks over the tower.");
	const clock = insertBox(database, chat.id, "world-clock");
	enableDecision();
	const stub = heldDecisionFetch();
	stopDigests = startBoxDigests(database, { fetch: stub.fetch });

	startBoxCatchUp(database, chat.id);
	await waitFor(() => stub.pending() === 1);
	cancelBoxCatchUp(database, chat.id);
	stub.release();
	startBoxCatchUp(database, chat.id);
	await waitFor(() => stub.pending() === 1);
	stub.release();
	await waitFor(() => readBoxCatchUp(database, chat.id) === null);
	expect(readRecordSlots(drizzle(database), "world-clock", clock, [passage]).get(passage)?.automatic?.weather).toBe("storm");
});

test("a live digest takes over a running catch-up job for the same Variant", async () => {
	const chat = createChat();
	const passage = addPassage(chat.id, 1, "The storm breaks over the tower.");
	const clock = insertBox(database, chat.id, "world-clock");
	enableDecision();
	const stub = heldDecisionFetch();
	stopDigests = startBoxDigests(database, { fetch: stub.fetch });

	startBoxCatchUp(database, chat.id);
	await waitFor(() => stub.pending() === 1);
	queueBoxDigests(database, { conversationId: chat.id, touchedVariantIds: [passage], removedVariantIds: [] });
	await waitFor(() => stub.contents().length === 2);
	stub.release();
	stub.release();
	await waitFor(() => readRecordSlots(drizzle(database), "world-clock", clock, [passage]).get(passage)?.automatic !== undefined);
});

test("a live digest runs before the catch-up jobs still queued behind it", async () => {
	const chat = createChat();
	addPassage(chat.id, 1, "The storm breaks over the tower.");
	addPassage(chat.id, 2, "Snow drifts against the shutters.");
	addPassage(chat.id, 3, "She lights the lamp.");
	insertBox(database, chat.id, "world-clock");
	enableDecision();
	const stub = heldDecisionFetch();
	stopDigests = startBoxDigests(database, { fetch: stub.fetch });

	startBoxCatchUp(database, chat.id);
	await waitFor(() => stub.pending() === 2);
	const live = addPassage(chat.id, 4, "The lantern gutters.");
	queueBoxDigests(database, { conversationId: chat.id, touchedVariantIds: [live], removedVariantIds: [] });
	stub.release();
	await waitFor(() => stub.pending() === 2);
	expect(stub.contents()[2]).toContain("The lantern gutters.");
});
