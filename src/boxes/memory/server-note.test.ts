import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Value } from "@sinclair/typebox/value";
import { openInitializedDatabase } from "../../server/database/database";
import { createChat } from "../../server/contract/prompt-preset-test-fixtures";
import { openObservedDatabase, setBoxState } from "../../server/test-fixtures/conversation";
import { memoryRoutes } from "./server-routes";
import { conversationMemoryAllowance, conversationMemoryAllowanceApplied, conversationMemoryAllowanceConflict } from "./contract";

const guidance = "\"Trainer\" in narration means Tanjs. Track injuries and promises closely.";

const saveNote = (database: Database, conversationId: number, expectedRevision: number, note: string) =>
	memoryRoutes(database).handle(new Request(`http://localhost/conversations/${conversationId}/note`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision, note }) }));

const saveAllowance = (database: Database, conversationId: number, expectedRevision: number, allowance: number) =>
	memoryRoutes(database).handle(new Request(`http://localhost/conversations/${conversationId}/allowance`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision, allowance }) }));

describe("Conversation Memory note", () => {
	let database: Database;
	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("rejects a note for a Chat without Memory and keeps no value for it", async () => {
		const observed = openObservedDatabase();
		const chat = createChat(observed);
		setBoxState(observed, chat.id, "memory", "absent");
		const rejected = await saveNote(observed, chat.id, 0, guidance);
		expect(rejected.status).toBe(422);
		expect(observed.query("SELECT key FROM conversation_data WHERE conversation_id = ? AND namespace = 'box:memory'").all(chat.id)).toEqual([]);
		observed.close();
	});

	test("saves a trimmed note against the shared settings revision and rejects stale and oversized commands", async () => {
		const chat = createChat(database);
		const routes = memoryRoutes(database);
		const read = await routes.handle(new Request(`http://localhost/conversations/${chat.id}/allowance`));
		expect(Value.Parse(conversationMemoryAllowance, await read.json())).toEqual({ revision: 0, allowance: 2048, note: "" });

		const saved = await saveNote(database, chat.id, 0, `  ${guidance}  `);
		expect(saved.status).toBe(200);
		expect(Value.Parse(conversationMemoryAllowanceApplied, await saved.json())).toMatchObject({ outcome: "applied", settings: { revision: 1, note: guidance, allowance: 2048 } });

		const stale = await saveNote(database, chat.id, 0, "The second writer's note.");
		expect(stale.status).toBe(409);
		expect(Value.Parse(conversationMemoryAllowanceConflict, await stale.json())).toMatchObject({ outcome: "conflict", expectedRevision: 0, actualRevision: 1, currentSettings: { revision: 1, note: guidance } });

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

});
