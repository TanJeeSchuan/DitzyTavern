import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initializeDatabase } from "./database";
import journal from "./migrations/meta/_journal.json";

test("0042 upgrades existing Chats to Default (Paint) without changing their story preset", async () => {
	await mkdir(".scratch", { recursive: true });
	const folder = await mkdtemp(join(process.cwd(), ".scratch/paint-upgrade-"));
	try {
		const database = new Database(":memory:");
		try {
			await cp(join(import.meta.dir, "migrations"), folder, { recursive: true });
			await writeFile(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.filter(({ idx }) => idx <= 41) }));
			initializeDatabase(database, folder);
			database.exec(`INSERT INTO conversation (id, name, creation_time, last_message_time) VALUES (1, 'Existing', '', '');
				INSERT INTO prompt_preset (id, name) VALUES (17, 'Custom story');
				INSERT INTO conversation_prompt_preset VALUES (1, 17);`);
			initializeDatabase(database);
			expect(database.query(`SELECT s.prompt_preset_id, s.brief_message_count, p.name, p.is_default_paint
				FROM conversation_prompt_preset s JOIN prompt_preset p ON p.id = s.paint_preset_id`).get())
				.toEqual({ prompt_preset_id: 17, brief_message_count: 5, name: "Default (Paint)", is_default_paint: 1 });
			expect(database.query(`SELECT b.reference FROM prompt_preset_block b JOIN prompt_preset p ON p.id = b.preset_id
				WHERE p.is_default_paint = 1 ORDER BY b.position`).all()).toEqual([{ reference: "cast-appearance" }, { reference: "lore" }, { reference: "history" }, { reference: "brief-instruction" }]);
			expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
		} finally { database.close(); }
	} finally { await rm(folder, { recursive: true, force: true }); }
});


test("0043 adds Cast Appearance immediately before Lore in an edited Default (Paint)", async () => {
	await mkdir(".scratch", { recursive: true });
	const folder = await mkdtemp(join(process.cwd(), ".scratch/cast-upgrade-"));
	const database = new Database(":memory:");
	try {
		await cp(join(import.meta.dir, "migrations"), folder, { recursive: true });
		await writeFile(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.filter(({ idx }) => idx <= 42) }));
		initializeDatabase(database, folder);
		database.exec(`UPDATE prompt_preset_block SET content = 'Use charcoal.' WHERE reference = 'brief-instruction';
			UPDATE prompt_preset_block SET position = position + 10 WHERE preset_id = (SELECT id FROM prompt_preset WHERE is_default_paint = 1);
			INSERT INTO prompt_preset_block (preset_id, position, reference, role, name, content)
			SELECT id, 1, 'instruction', 'system', 'Style', 'Keep my edit.' FROM prompt_preset WHERE is_default_paint = 1;`);
		initializeDatabase(database);
		expect(database.query(`SELECT reference, content FROM prompt_preset_block WHERE preset_id = (SELECT id FROM prompt_preset WHERE is_default_paint = 1) ORDER BY position`).all())
			.toEqual([{ reference: "instruction", content: "Keep my edit." }, { reference: "cast-appearance", content: null }, { reference: "lore", content: null }, { reference: "history", content: null }, { reference: "brief-instruction", content: "Use charcoal." }]);
		expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
	} finally { database.close(); await rm(folder, { recursive: true, force: true }); }
});
