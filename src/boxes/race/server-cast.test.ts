import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { openInitializedDatabase } from "../../server/database/database";
import { participantDataTable } from "../../server/database/schema";
import { createConversationWithHistory } from "../../server/test-fixtures/conversation";
import { readRaceCastStats } from "./server-cast";

const prompt = () => ({
	systemInstruction: "",
	identity: "",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
});

test("decodes each Participant's own race stats and ignores unrelated keys", () => {
	const database = openInitializedDatabase({ path: ":memory:" });
	try {
		const conversation = createConversationWithHistory(database, {
			name: "Race cast",
			participants: ["A", "B", "C"].map((name) => ({ definition: { name, prompt: prompt(), openings: [] } })),
		});
		const [first, second, third] = conversation.cast.map(({ id }) => id);
		drizzle(database).insert(participantDataTable).values([
			{ participant_id: first!, namespace: "box:race", key: "stats", value: JSON.stringify({ style: "Front Runner", speed: 700, stamina: 600, power: 500, guts: 400, wit: 300 }) },
			{ participant_id: second!, namespace: "box:race", key: "avatar", value: "ignored" },
			{ participant_id: third!, namespace: "box:author-note", key: "stats", value: "{}" },
		]).run();
		expect(readRaceCastStats(drizzle(database), [first!, second!, third!])).toEqual([
			{ participantId: first!, stats: { style: "Front Runner", speed: 700, stamina: 600, power: 500, guts: 400, wit: 300 } },
		]);
		expect(readRaceCastStats(drizzle(database), [])).toEqual([]);
	} finally {
		database.close();
	}
});

test("a stored stats value that no longer decodes is an error", () => {
	const database = openInitializedDatabase({ path: ":memory:" });
	try {
		const conversation = createConversationWithHistory(database, {
			name: "Race cast",
			participants: [{ definition: { name: "A", prompt: prompt(), openings: [] } }],
		});
		const db = drizzle(database);
		db.insert(participantDataTable).values({ participant_id: conversation.cast[0]!.id, namespace: "box:race", key: "stats", value: "{}" }).run();
		expect(() => readRaceCastStats(db, [conversation.cast[0]!.id])).toThrow("Clear the box:race namespace");
	} finally {
		database.close();
	}
});
