import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { initializeConnectionSecretKey } from "../connection-secrets";
import { configureDecisionModels } from "../contract/decision-model-test-fixtures";
import type { ModelFetch } from "../model-client/types";
import { createConversationWithHistory, insertBox, openObservedDatabase, setBoxState } from "../test-fixtures/conversation";
import { cancelBoxCatchUp, queueBoxDigest, prepareBoxDigests, readBoxCatchUp, startBoxCatchUp, startBoxDigests } from "./digest";
import { readRecordSlots } from "./records";
import { executeConversationCommand, observeConversationWrites, readConversationSummary, readSelectedPassages } from "../conversation";
import memoryBox from "../../boxes/memory/server";
import worldClockBox from "../../boxes/world-clock/server";
import { worldClockRecord } from "../../boxes/world-clock/contract";
import type { DigestWindow } from "./contract";
import { subscribeDatabaseChanges, watchDatabaseChanges } from "../database/changes";

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
//  A request released with `fail` answers HTTP 500.
const heldDecisionFetch = () => {
	const releases: ((fail: boolean) => void)[] = [];
	const contents: string[] = [];
	return {
		fetch: ((_input, init) => new Promise<Response>((resolve) => {
			const request: StubDecisionRequest = JSON.parse(String(init?.body));
			contents.push(String(init?.body));
			releases.push((fail) => resolve(fail ? new Response("", { status: 500 }) : decisionResponse(request)));
		})) satisfies ModelFetch,
		release: (fail = false) => { releases.shift()?.(fail); },
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

// @approved
//  A Clock Chat without Memory, so only the World Clock digests its passages.
const createChat = () => {
	const chat = createConversationWithHistory(database, {
		name: "Clock Chat",
		participants: [
			{ definition: { name: "Writer", prompt, openings: [] } },
			{ definition: { name: "Maren", prompt, openings: [] } },
		],
		control: { human: 0, model: 1 },
	});
	setBoxState(database, chat.id, "memory", "absent");
	return chat;
};

const addPassage = (conversationId: number, position: number, content: string): number => {
	const message = database.query<{ id: number }, [number, number]>("INSERT INTO messages (conversation_id, position, timestamp) VALUES (?, ?, '2026-01-01') RETURNING id").get(conversationId, position);
	if (message === null) throw new Error("The test Message was not inserted.");
	const variant = database.query<{ id: number }, [number, string]>(
		"INSERT INTO message_variant (message_id, position, content, timestamp, selected) VALUES (?, 0, ?, '2026-01-01', 1) RETURNING id",
	).get(message.id, content);
	if (variant === null) throw new Error("The test Variant was not inserted.");
	return variant.id;
};

const enableDecision = () => configureDecisionModels(database, masterKey);

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

	startBoxCatchUp(database, chat.id, "world-clock");
	expect(readBoxCatchUp(database, chat.id, "world-clock")).toEqual({ total: 2, remaining: 2, failed: 0 });
	await waitFor(() => stub.pending() === 2);
	stub.release();
	await waitFor(() => readBoxCatchUp(database, chat.id, "world-clock")?.remaining === 1);
	stub.release();
	await waitFor(() => readBoxCatchUp(database, chat.id, "world-clock") === null);

	const records = readRecordSlots(drizzle(database), "world-clock", worldClockRecord, clock, [first, second]);
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

	startBoxCatchUp(database, chat.id, "world-clock");
	await waitFor(() => stub.pending() === 1);
	cancelBoxCatchUp(database, chat.id, "world-clock");
	expect(readBoxCatchUp(database, chat.id, "world-clock")).toBeNull();
	stub.release();
	await stopDigests();
	stopDigests = undefined;
	expect(readRecordSlots(drizzle(database), "world-clock", worldClockRecord, clock, [passage]).size).toBe(0);
});

test("a catch-up run announces its start and its cancellation, which no row records", async () => {
	const chat = createChat();
	addPassage(chat.id, 1, "The storm breaks over the tower.");
	insertBox(database, chat.id, "world-clock");
	enableDecision();
	const stub = heldDecisionFetch();
	stopDigests = startBoxDigests(database, { fetch: stub.fetch });
	// @approved A ticker that never ticks during the test, so only announcements are heard.
	const stopWatch = watchDatabaseChanges(database, 60_000);
	const heard: number[] = [];
	subscribeDatabaseChanges(database, (seq) => heard.push(seq), () => {});
	try {
		startBoxCatchUp(database, chat.id, "world-clock");
		expect(heard).toEqual([0, 1]);
		await waitFor(() => stub.pending() === 1);
		cancelBoxCatchUp(database, chat.id, "world-clock");
		expect(heard).toEqual([0, 1, 2]);
	} finally {
		stopWatch();
		stub.release();
	}
});

test("a clock that stops running abandons its in-flight digest, even when it is enabled again before the result lands", async () => {
	const chat = createChat();
	const passage = addPassage(chat.id, 1, "The storm breaks over the tower.");
	const clock = insertBox(database, chat.id, "world-clock");
	enableDecision();
	const stub = heldDecisionFetch();
	stopDigests = startBoxDigests(database, { fetch: stub.fetch });

	prepareBoxDigests(database, { conversationId: chat.id, touchedVariantIds: [passage], removedVariantIds: [] })();
	await waitFor(() => stub.pending() === 1);
	prepareBoxDigests(database, { conversationId: chat.id, touchedVariantIds: [], removedVariantIds: [], stoppedBox: "world-clock" })();
	stub.release();
	await stopDigests();
	stopDigests = undefined;
	expect(readRecordSlots(drizzle(database), "world-clock", worldClockRecord, clock, [passage]).size).toBe(0);
});

test("a cancelled run can be restarted for the same Variants before the aborted job settles", async () => {
	const chat = createChat();
	const passage = addPassage(chat.id, 1, "The storm breaks over the tower.");
	const clock = insertBox(database, chat.id, "world-clock");
	enableDecision();
	const stub = heldDecisionFetch();
	stopDigests = startBoxDigests(database, { fetch: stub.fetch });

	startBoxCatchUp(database, chat.id, "world-clock");
	await waitFor(() => stub.pending() === 1);
	cancelBoxCatchUp(database, chat.id, "world-clock");
	stub.release();
	startBoxCatchUp(database, chat.id, "world-clock");
	await waitFor(() => stub.pending() === 1);
	stub.release();
	await waitFor(() => readBoxCatchUp(database, chat.id, "world-clock") === null);
	expect(readRecordSlots(drizzle(database), "world-clock", worldClockRecord, clock, [passage]).get(passage)?.automatic?.weather).toBe("storm");
});

test("a live digest takes over a running catch-up job for the same Variant", async () => {
	const chat = createChat();
	const passage = addPassage(chat.id, 1, "The storm breaks over the tower.");
	const clock = insertBox(database, chat.id, "world-clock");
	enableDecision();
	const stub = heldDecisionFetch();
	stopDigests = startBoxDigests(database, { fetch: stub.fetch });

	startBoxCatchUp(database, chat.id, "world-clock");
	await waitFor(() => stub.pending() === 1);
	prepareBoxDigests(database, { conversationId: chat.id, touchedVariantIds: [passage], removedVariantIds: [] })();
	await waitFor(() => stub.contents().length === 2);
	stub.release();
	stub.release();
	await waitFor(() => readRecordSlots(drizzle(database), "world-clock", worldClockRecord, clock, [passage]).get(passage)?.automatic !== undefined);
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

	startBoxCatchUp(database, chat.id, "world-clock");
	await waitFor(() => stub.pending() === 2);
	const live = addPassage(chat.id, 4, "The lantern gutters.");
	prepareBoxDigests(database, { conversationId: chat.id, touchedVariantIds: [live], removedVariantIds: [] })();
	stub.release();
	await waitFor(() => stub.pending() === 2);
	expect(stub.contents()[2]).toContain("The lantern gutters.");
});

test("a digest window reads exactly the preceding Messages it declares", () => {
	const chat = createChat();
	const last = ["One.", "Two.", "Three.", "Four.", "Five.", "Six."].map((content, index) => addPassage(chat.id, index + 1, content)).at(-1) ?? 0;
	const source = database.query<{ id: number }, [number]>("SELECT message_id AS id FROM message_variant WHERE id = ?").get(last)?.id ?? 0;
	const read = (preceding: number) => readSelectedPassages(database, chat.id, { messageId: source, preceding })?.map((message) => message.variant?.content);
	expect(read(0)).toEqual(["Six."]);
	expect(read(5)).toEqual(["One.", "Two.", "Three.", "Four.", "Five.", "Six."]);
});

test("a failed digest keeps its error, live work skips that text, and catch-up retries it", async () => {
	const chat = createChat();
	const passage = addPassage(chat.id, 1, "The storm breaks over the tower.");
	const clock = insertBox(database, chat.id, "world-clock");
	enableDecision();
	const stub = heldDecisionFetch();
	stopDigests = startBoxDigests(database, { fetch: stub.fetch });
	const slot = () => readRecordSlots(drizzle(database), "world-clock", worldClockRecord, clock, [passage]).get(passage);

	prepareBoxDigests(database, { conversationId: chat.id, touchedVariantIds: [passage], removedVariantIds: [] })();
	await waitFor(() => stub.pending() === 1);
	stub.release(true);
	await waitFor(() => slot()?.error !== undefined);
	expect(slot()?.error?.message).toBe("Decision Model request failed with HTTP 500.");

	// @approved
	//  Had live work queued the failed text again, catch-up would find it
	//  already queued and start no run.
	prepareBoxDigests(database, { conversationId: chat.id, touchedVariantIds: [passage], removedVariantIds: [] })();
	startBoxCatchUp(database, chat.id, "world-clock");
	expect(readBoxCatchUp(database, chat.id, "world-clock")).toEqual({ total: 1, remaining: 1, failed: 0 });
	await waitFor(() => stub.pending() === 1);
	stub.release();
	await waitFor(() => readBoxCatchUp(database, chat.id, "world-clock") === null);
	expect(slot()?.automatic?.weather).toBe("storm");
	expect(slot()?.error).toBeUndefined();
});

test("digesting one passage retries text whose digest failed and leaves digested text alone", async () => {
	const chat = createChat();
	const passage = addPassage(chat.id, 1, "The storm breaks over the tower.");
	const clock = insertBox(database, chat.id, "world-clock");
	enableDecision();
	const stub = heldDecisionFetch();
	stopDigests = startBoxDigests(database, { fetch: stub.fetch });
	const slot = () => readRecordSlots(drizzle(database), "world-clock", worldClockRecord, clock, [passage]).get(passage);

	prepareBoxDigests(database, { conversationId: chat.id, touchedVariantIds: [passage], removedVariantIds: [] })();
	await waitFor(() => stub.pending() === 1);
	stub.release(true);
	await waitFor(() => slot()?.error !== undefined);
	queueBoxDigest(database, chat.id, "world-clock", { variantId: passage });
	await waitFor(() => stub.pending() === 1);
	stub.release();
	await waitFor(() => slot()?.automatic !== undefined);
	queueBoxDigest(database, chat.id, "world-clock", { variantId: passage });
	await Bun.sleep(5);
	expect(stub.contents()).toHaveLength(2);
});

test("a catch-up run reports how many of its passages failed", async () => {
	const chat = createChat();
	addPassage(chat.id, 1, "The storm breaks over the tower.");
	addPassage(chat.id, 2, "Snow drifts against the shutters.");
	insertBox(database, chat.id, "world-clock");
	enableDecision();
	const stub = heldDecisionFetch();
	stopDigests = startBoxDigests(database, { fetch: stub.fetch });

	startBoxCatchUp(database, chat.id, "world-clock");
	await waitFor(() => stub.pending() === 2);
	stub.release(true);
	await waitFor(() => readBoxCatchUp(database, chat.id, "world-clock")?.remaining === 1);
	expect(readBoxCatchUp(database, chat.id, "world-clock")).toEqual({ total: 2, remaining: 1, failed: 1 });
	stub.release();
	await waitFor(() => readBoxCatchUp(database, chat.id, "world-clock") === null);
});

test("a digest reads its passages' Message ids, the Cast and its own Chat values but none of the host's", async () => {
	const chat = createChat();
	addPassage(chat.id, 1, "The storm breaks over the tower.");
	const passage = addPassage(chat.id, 2, "Snow drifts against the shutters.");
	insertBox(database, chat.id, "world-clock");
	database.query("INSERT INTO conversation_data (conversation_id, namespace, key, value) VALUES (?, 'box:world-clock', 'tuning', ?)").run(chat.id, JSON.stringify({ kept: true }));
	enableDecision();
	const windows: DigestWindow[] = [];
	const run = spyOn(worldClockBox.records.digest, "run").mockImplementation(async (window) => {
		windows.push(window);
		return { minutes: 0, weather: null };
	});
	try {
		stopDigests = startBoxDigests(database);
		prepareBoxDigests(database, { conversationId: chat.id, touchedVariantIds: [passage], removedVariantIds: [] })();
		await waitFor(() => windows.length === 1);
	} finally { run.mockRestore(); }
	const messageIds = database.query<{ id: number }, [number]>("SELECT id FROM messages WHERE conversation_id = ? ORDER BY position").all(chat.id).map((row) => row.id);
	expect(windows[0]?.passage).toEqual({ messageId: messageIds[1]!, speaker: null, authorId: null, content: "Snow drifts against the shutters." });
	expect(windows[0]?.preceding.map((entry) => entry.messageId)).toEqual([messageIds[0]!]);
	expect(windows[0]?.cast.map(({ name, removed }) => ({ name, removed }))).toEqual([{ name: "Writer", removed: false }, { name: "Maren", removed: false }]);
	expect(windows[0]?.data).toEqual({ tuning: JSON.stringify({ kept: true }) });
});


test("a rejected edit leaves the running Memory catch-up intact", async () => {
	const chat = createChat();
	setBoxState(database, chat.id, "memory", "enabled");
	const passage = addPassage(chat.id, 1, "Original passage.");
	const clock = insertBox(database, chat.id, "world-clock");
	enableDecision();
	database.query("INSERT INTO message_variant_data (message_variant_id, namespace, key, value) VALUES (?, ?, ?, ?)")
		.run(passage, "box:world-clock", `record:${clock}`, '{"automatic":{"minutes":"bad","weather":null}}');
	let signal: AbortSignal | undefined;
	let release: (() => void) | undefined;
	const run = spyOn(memoryBox.records.digest, "run").mockImplementation(async (_window, services) => {
		signal = services.signal;
		await new Promise<void>((resolve) => { release = resolve; });
		return { claims: [] };
	});
	stopDigests = startBoxDigests(database);
	observeConversationWrites(database, prepareBoxDigests);
	try {
		startBoxCatchUp(database, chat.id, "memory");
		await waitFor(() => signal !== undefined);
		const revision = readConversationSummary(database, chat.id)!.revision;
		const messageId = database.query<{ id: number }, [number]>("SELECT message_id AS id FROM message_variant WHERE id = ?").get(passage)!.id;
		expect(() => executeConversationCommand(database, {
			conversationId: chat.id, expectedRevision: revision,
			action: { type: "edit-variant", messageId, variantId: passage, content: "Rejected edit." },
		})).toThrow("does not match its schema");
		expect(readConversationSummary(database, chat.id)!.revision).toBe(revision);
		expect(readSelectedPassages(database, chat.id)![0]!.variant!.content).toBe("Original passage.");
		expect(signal!.aborted).toBe(false);
		expect(readBoxCatchUp(database, chat.id, "memory")).toEqual({ total: 1, remaining: 1, failed: 0 });
		release!();
		await waitFor(() => readBoxCatchUp(database, chat.id, "memory") === null);
		expect(database.query<{ value: string }, [number]>("SELECT value FROM message_variant_data WHERE message_variant_id = ? AND namespace = 'box:memory'").get(passage)?.value).toContain('"claims":[]');
	} finally {
		release?.();
		await stopDigests();
		stopDigests = undefined;
		run.mockRestore();
	}
});
