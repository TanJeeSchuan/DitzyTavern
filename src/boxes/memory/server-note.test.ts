import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Value } from "@sinclair/typebox/value";
import { openInitializedDatabase } from "../../server/database/database";
import { createChat } from "../../server/contract/prompt-preset-test-fixtures";
import { insertBox, openObservedDatabase, setBoxState } from "../../server/test-fixtures/conversation";
import { memoryRoutes } from "./server-routes";
import { readMemoryChatSettings } from "./server-chat";
import { conversationMemoryAllowance, conversationMemoryAllowanceApplied, conversationMemoryAllowanceConflict } from "./contract";

const guidance = "\"Trainer\" in narration means Tanjs. Track injuries and promises closely.";

const saveNote = (database: Database, conversationId: number, expectedRevision: string, note: string) =>
	memoryRoutes(database).handle(new Request(`http://localhost/conversations/${conversationId}/note`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision, note }) }));

const saveAllowance = (database: Database, conversationId: number, expectedRevision: string, allowance: number) =>
	memoryRoutes(database).handle(new Request(`http://localhost/conversations/${conversationId}/allowance`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision, allowance }) }));

const settingsOf = (database: Database, conversationId: number) => readMemoryChatSettings(database, conversationId);

describe("Conversation Memory note", () => {
	let database: Database;
	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("rejects a note for a Chat without Memory and keeps no value for it", async () => {
		const observed = openObservedDatabase();
		const chat = createChat(observed);
		const stale = settingsOf(observed, chat.id).revision;
		setBoxState(observed, chat.id, "memory", "absent");
		const rejected = await saveNote(observed, chat.id, stale, guidance);
		expect(rejected.status).toBe(422);
		expect(observed.query("SELECT key FROM conversation_data WHERE conversation_id = ? AND namespace = 'box:memory'").all(chat.id)).toEqual([]);
		observed.close();
	});

	test("saves a trimmed note against the shared settings revision and rejects stale and oversized commands", async () => {
		const chat = createChat(database);
		const routes = memoryRoutes(database);
		const read = await routes.handle(new Request(`http://localhost/conversations/${chat.id}/allowance`));
		const initial = Value.Parse(conversationMemoryAllowance, await read.json());
		expect(initial).toMatchObject({ allowance: 2048, note: "" });

		const saved = await saveNote(database, chat.id, initial.revision, `  ${guidance}  `);
		expect(saved.status).toBe(200);
		const noted = Value.Parse(conversationMemoryAllowanceApplied, await saved.json());
		expect(noted).toMatchObject({ outcome: "applied", settings: { note: guidance, allowance: 2048 } });
		expect(noted.settings.revision).not.toBe(initial.revision);

		const stale = await saveNote(database, chat.id, initial.revision, "The second writer's note.");
		expect(stale.status).toBe(409);
		expect(Value.Parse(conversationMemoryAllowanceConflict, await stale.json())).toMatchObject({
			outcome: "conflict", expectedRevision: initial.revision, actualRevision: noted.settings.revision, currentSettings: { revision: noted.settings.revision, note: guidance },
		});

		const oversized = await saveNote(database, chat.id, noted.settings.revision, "x".repeat(2_001));
		expect(oversized.status).toBe(422);
		expect(await oversized.text()).toContain("2,000 characters");

		const allowance = await saveAllowance(database, chat.id, noted.settings.revision, 100);
		expect(allowance.status).toBe(200);
		const allowed = Value.Parse(conversationMemoryAllowanceApplied, await allowance.json());
		expect(allowed).toMatchObject({ outcome: "applied", settings: { allowance: 100, note: guidance } });

		const cleared = await saveNote(database, chat.id, allowed.settings.revision, "   ");
		expect(cleared.status).toBe(200);
		expect(Value.Parse(conversationMemoryAllowanceApplied, await cleared.json())).toMatchObject({ outcome: "applied", settings: { note: "" } });
	});

	test("a draft read before the Box was removed cannot overwrite the reinserted Box's value at the same row revision", async () => {
		const observed = openObservedDatabase();
		try {
			const chat = createChat(observed);
			const first = settingsOf(observed, chat.id).revision;
			expect((await saveNote(observed, chat.id, first, guidance)).status).toBe(200);
			const staleDraft = settingsOf(observed, chat.id).revision;

			setBoxState(observed, chat.id, "memory", "disabled");
			expect((await saveNote(observed, chat.id, staleDraft, `${guidance} Kept while off.`)).status).toBe(200);
			const disabledDraft = settingsOf(observed, chat.id).revision;
			setBoxState(observed, chat.id, "memory", "enabled");
			expect((await saveNote(observed, chat.id, disabledDraft, guidance)).status).toBe(200);

			setBoxState(observed, chat.id, "memory", "absent");
			insertBox(observed, chat.id, "memory");
			const reinserted = settingsOf(observed, chat.id).revision;
			expect((await saveNote(observed, chat.id, reinserted, "The reinserted note.")).status).toBe(200);
			expect(settingsOf(observed, chat.id).note).toBe("The reinserted note.");

			const replayed = await saveNote(observed, chat.id, staleDraft, "The stale note.");
			expect(replayed.status).toBe(409);
			expect(settingsOf(observed, chat.id).note).toBe("The reinserted note.");
		} finally { observed.close(); }
	});
});
