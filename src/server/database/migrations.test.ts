import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { initializeDatabase } from "./database";
import journal from "./migrations/meta/_journal.json";
import { builtInBoxes, loadBoxes } from "../box/registry";
import { observeConversationWrites, readConversationSummary, readVariantData } from "../conversation";
import { recoverActiveGenerations } from "../workflows/generation-recovery";
import { readBoxDecisionSettings } from "../box/decision-settings";
import { readRecordSlots } from "../box/records";
import { readBoxLifecycles } from "../box/setup";
import { sha256 } from "../hash";
import { memoryRecord, type MemoryRecord } from "../../boxes/memory/contract";
import { createMemorySettingsModule } from "../../boxes/memory/server-settings";
import { readMemoryChatSettings, readMemoryLabelState } from "../../boxes/memory/server-chat";

test.each([true, false])("preserves pre-Box chats and Memory when globally enabled=%s", async (enabled) => {
	const database = new Database(":memory:");
	const folder = await mkdtemp(join(tmpdir(), "ditzy-upgrade-"));
	try {
		await cp(join(import.meta.dir, "migrations"), folder, { recursive: true });
		await writeFile(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.filter(({ idx }) => idx <= 16) }));
		initializeDatabase(database, folder);
		database.exec(`
			INSERT INTO conversation (id, name, creation_time, last_message_time, author_note)
			VALUES (1, 'Upgrade', '2026-10-01', '2026-10-01', 'Keep "quoted" guidance. 日本語'), (2, 'Empty note', '2026-10-01', '2026-10-01', '');
			INSERT INTO connection_profile (id, display_name, api_format, request_url, model_backend, adapter)
			VALUES (1, 'Chat', 'chat-completions', 'https://example.test/', 'automatic', 'openai-compatible');
			INSERT INTO memory_settings (id, enabled, extraction_profile_id, extraction_model, decision_profile_id, decision_model, decision_state_token_limit)
			VALUES (1, ${Number(enabled)}, 1, 'extractor', 1, 'judge', 8192);
			INSERT INTO conversation_memory_settings (conversation_id, allowance, memory_note, identities, label_merges)
			VALUES (1, 20480, 'Keep the secret.', '{"1":{"kind":"excluded"}}', '[{"from":"Old","to":"New"}]');
			INSERT INTO participant (id, conversation_id, name, position) VALUES (1, 1, 'Writer', 0);
		`);
		const claims: MemoryRecord["claims"] = [{
			claim: "A kept fact", attribution: "Narrator", people: [], evidence: [],
			judgment: { support: "supported", attribution: "correct", usefulness: "retain", probabilities: {}, confidence: {} },
		}];
		const cases = [
			{ ownership: "automatic", status: "complete", claims },
			{ ownership: "writer", status: "complete", claims: [] },
			{ ownership: "automatic", status: "failed", claims: [] },
			{ ownership: "automatic", status: "running", claims: [] },
		];
		for (const [index, entry] of cases.entries()) {
			const id = index + 1;
			database.query("INSERT INTO messages (id, conversation_id, position, timestamp) VALUES (?, 1, ?, '2026-10-01')").run(id, index);
			database.query("INSERT INTO message_variant (id, message_id, position, content, timestamp, selected) VALUES (?, ?, 0, 'Source', '2026-10-01', 1)").run(id, id);
			database.query(`INSERT INTO memory_collection (variant_id, conversation_id, message_id, source_hash, ownership, status, claims_json, source_snapshot_json, error, updated_at)
				VALUES (?, 1, ?, ?, ?, ?, ?, '{}', ?, '2026-10-01')`).run(
				id, id, sha256("Source"), entry.ownership, entry.status, JSON.stringify(entry.claims), entry.status === "failed" ? "Provider failed" : null,
			);
		}
		database.exec(`
			INSERT INTO memory_catchup_run (conversation_id, created_at) VALUES (1, '2026-10-01');
			UPDATE memory_collection SET catchup_run_id = (SELECT id FROM memory_catchup_run LIMIT 1);
		`);
		database.query("INSERT INTO memory_embedding_cache VALUES ('space', 'hash', ?)").run(new Uint8Array([1, 2, 3, 4]));

		initializeDatabase(database);
		await loadBoxes([builtInBoxes], database);
		expect(readConversationSummary(database, 1)).toMatchObject({
			boxes: { "author-note": "enabled", memory: enabled ? "enabled" : "disabled" },
			boxSetups: { "author-note": 'Keep "quoted" guidance. 日本語' },
		});
		expect(readConversationSummary(database, 2)?.boxes["author-note"]).toBe("enabled");
		expect(createMemorySettingsModule(database).get()).toMatchObject({ extractionProfileId: 1, extractionModel: "extractor" });
		expect(readBoxDecisionSettings(database, "memory")).toMatchObject({ decisionProfileId: 1, decisionModel: "judge", decisionStateTokenLimit: 8192 });
		expect(readMemoryChatSettings(database, 1)).toMatchObject({ allowance: 20480, note: "Keep the secret." });
		expect(readMemoryLabelState(database, 1)).toMatchObject({ identities: { "1": { kind: "excluded" } }, merges: [{ from: "Old", to: "New" }] });
		const instance = readBoxLifecycles(drizzle(database), 1).memory?.instance;
		const slots = readRecordSlots(drizzle(database), "memory", memoryRecord, instance, [1, 2, 3, 4]);
		expect(slots.get(1)).toEqual({ automatic: { claims }, source: sha256("Source") });
		expect(slots.get(2)).toEqual({ writer: { claims: [] }, source: sha256("Source") });
		expect(slots.get(3)).toEqual({ error: { source: sha256("Source"), message: "Provider failed" } });
		expect(slots.has(4)).toBe(false);
		expect(database.query("SELECT vector FROM embedding_cache").get()).toEqual({ vector: new Uint8Array([1, 2, 3, 4]) });
		initializeDatabase(database);
		expect(readBoxLifecycles(drizzle(database), 1).memory?.instance).toBe(instance);
		expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);

		expect(database.query("SELECT name FROM sqlite_schema WHERE name IN ('memory_collection', 'memory_catchup_run')").all()).toEqual([]);
	} finally {
		database.close();
		await loadBoxes([builtInBoxes]);
		await rm(folder, { recursive: true, force: true });
	}
});

test("upgrades Request Overrides namespaces without replacing authored overrides", async () => {
	const database = new Database(":memory:");
	try {
		database.exec("CREATE TABLE conversation_generation_settings (conversation_id INTEGER PRIMARY KEY, request_overrides_json TEXT NOT NULL)");
		const overrides = [
			{},
			{ "chat-completions": { stop: ["END"], nested: { enabled: true } } },
			{ "chat-completions": {}, responses: { max_output_tokens: 64 }, "anthropic-messages": { top_k: 3 } },
		];
		for (const [id, value] of overrides.entries()) {
			database.query("INSERT INTO conversation_generation_settings VALUES (?, ?)").run(id, JSON.stringify(value));
		}

		const migration = await Bun.file(new URL("./migrations/0029_request_override_namespaces.sql", import.meta.url)).text();
		for (let run = 0; run < 2; run++) {
			database.exec(migration);
			expect(database.query<{ request_overrides_json: string }, []>("SELECT request_overrides_json FROM conversation_generation_settings ORDER BY conversation_id").all()
				.map((row) => JSON.parse(row.request_overrides_json))).toEqual([
				{ "chat-completions": {}, responses: {}, "anthropic-messages": {} },
				{ "chat-completions": { stop: ["END"], nested: { enabled: true } }, responses: {}, "anthropic-messages": {} },
				overrides[2],
			]);
		}
	} finally {
		database.close();
	}
});

test("an Active Generation interrupted by the checkpoint-delta upgrade still recovers its output", async () => {
	const database = new Database(":memory:");
	const folder = await mkdtemp(join(tmpdir(), "ditzy-upgrade-"));
	try {
		await cp(join(import.meta.dir, "migrations"), folder, { recursive: true });
		await writeFile(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.filter(({ idx }) => idx <= 29) }));
		initializeDatabase(database, folder);
		database.exec(`
			INSERT INTO conversation (id, name, creation_time, last_message_time) VALUES (1, 'Upgrade', '2026-10-25', '2026-10-25');
			INSERT INTO participant (id, conversation_id, name, position) VALUES (1, 1, 'Writer', 1), (2, 1, 'Maren', 2);
			INSERT INTO messages (id, conversation_id, position, timestamp) VALUES (1, 1, 0, '2026-10-25');
			INSERT INTO message_variant (id, message_id, position, content, timestamp, selected) VALUES (1, 1, 0, '', '2026-10-25', 1);
			INSERT INTO active_generation (id, conversation_id, message_id, variant_id, human_participant_id, model_participant_id, captured_model_name, started_at,
				prompt_plan_json, prompt_context_json, generation_settings_json, connection_json, checkpoint_content, checkpoint_reasoning, checkpoint_event_id)
			VALUES (1, 1, 1, 1, 1, 2, 'Maren', '2026-10-25', '{"blocks":[],"warnings":[],"images":[]}', '[]', '{}', '{}', 'The tide turns.', 'Watch the pier.', 7);
		`);
		initializeDatabase(database);
		observeConversationWrites(database, () => () => {});
		expect(recoverActiveGenerations(database)).toMatchObject({ interrupted: 1, removed: 0, failed: 0 });
		expect(database.query<{ content: string }, []>("SELECT content FROM message_variant WHERE id = 1").get()?.content).toBe("The tide turns.");
		expect(readVariantData(drizzle(database), [1], ["reasoning"]).get(1)?.reasoning).toBe("Watch the pier.");
	} finally {
		database.close();
		await rm(folder, { recursive: true, force: true });
	}
});
