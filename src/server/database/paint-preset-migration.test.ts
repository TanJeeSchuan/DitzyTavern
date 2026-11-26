import { databaseAtMigration } from "../test-fixtures/migrations";
import { createConversationWithHistory } from "../test-fixtures/conversation";
import { expect, test } from "bun:test";
import { initializeDatabase } from "./database";
import { createPaintingModule } from "../painting";

test("0042 upgrades existing Chats to Default (Paint) without changing their story preset", async () => {
	using database = await databaseAtMigration(41);
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
});


test("0043 adds Cast Appearance immediately before Lore in an edited Default (Paint)", async () => {
	using database = await databaseAtMigration(42);
	database.exec(`UPDATE prompt_preset_block SET content = 'Use charcoal.' WHERE reference = 'brief-instruction';
			UPDATE prompt_preset_block SET position = position + 10 WHERE preset_id = (SELECT id FROM prompt_preset WHERE is_default_paint = 1);
			INSERT INTO prompt_preset_block (preset_id, position, reference, role, name, content)
			SELECT id, 1, 'instruction', 'system', 'Style', 'Keep my edit.' FROM prompt_preset WHERE is_default_paint = 1;`);
	initializeDatabase(database);
	expect(database.query(`SELECT reference, content FROM prompt_preset_block WHERE preset_id = (SELECT id FROM prompt_preset WHERE is_default_paint = 1) ORDER BY position`).all())
		.toEqual([{ reference: "instruction", content: "Keep my edit." }, { reference: "cast-appearance", content: null }, { reference: "lore", content: null }, { reference: "history", content: null }, { reference: "brief-instruction", content: "Use charcoal." }]);
	expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("0044 backfills Ask for attached Illustrations", async () => {
	using database = await databaseAtMigration(43);
	database.exec("CREATE TEMP TABLE conversation_generation_settings (conversation_id INTEGER PRIMARY KEY, connection_profile_id INTEGER, settings_json TEXT NOT NULL)");
	const chat = createConversationWithHistory(database, { name: "Existing", messages: [{ variants: [{ content: "Scene", timestamp: "", selected: true }], timestamp: "" }] });
	database.exec("DROP TABLE temp.conversation_generation_settings");
	const variant = chat.messages[0]!.variants[0]!;
	database.run("INSERT INTO message_variant_data (message_variant_id, namespace, key, value) VALUES (?, 'painting', 'old', ?)", [variant.id, '{"brief":"A bridge","aspectRatio":"1:1"}']);
	initializeDatabase(database);
	expect(database.query("SELECT json_extract(value, '$.ask') AS ask FROM message_variant_data").get()).toEqual({ ask: "" });
});

test("0046 opens a Gallery with kept Illustrations from before and after Ask", async () => {
	using database = await databaseAtMigration(45);
	const chat = createConversationWithHistory(database, { name: "Existing", messages: [{ variants: [{ content: "Scene", timestamp: "", selected: true }], timestamp: "" }] });
	const variant = chat.messages[0]!.variants[0]!;
	const stored = { aspectRatio: "1:1", imageModel: { profileId: 1, model: "painter" } };
	const attached = { ...stored, image: `image:${"a".repeat(64)}`, brief: "A bridge", ask: "At dusk" };
	const kept = { ...stored, image: `image:${"b".repeat(64)}`, brief: "A tower", ask: "Draw a tower" };
	const legacy = { ...stored, image: `image:${"c".repeat(64)}`, brief: "A lake" };
	const upload = { image: `image:${"d".repeat(64)}`, name: "An upload" };
	database.run("INSERT INTO message_variant_data (message_variant_id, namespace, key, value) VALUES (?, 'painting', 'old', ?)", [variant.id, JSON.stringify(attached)]);
	database.run(`INSERT INTO conversation_data (conversation_id, namespace, key, value) VALUES
		(?, 'painting', 'gallery:kept', ?),
		(?, 'painting', 'gallery:legacy', ?),
		(?, 'painting', 'gallery:upload', ?)`, [chat.id, JSON.stringify(kept), chat.id, JSON.stringify(legacy), chat.id, JSON.stringify(upload)]);
	initializeDatabase(database);
	const gallery = createPaintingModule(database).gallery(chat.id);
	expect(gallery.map(({ keptId, name, painted }) => ({ keptId, name, painted }))).toEqual([
		{ keptId: undefined, name: "At dusk", painted: { brief: "A bridge", ask: "At dusk", references: "" } },
		{ keptId: "kept", name: "Draw a tower", painted: { brief: "A tower", ask: "Draw a tower", references: "" } },
		{ keptId: "legacy", name: "Illustration", painted: { brief: "A lake", ask: "", references: "" } },
		{ keptId: "upload", name: "An upload", painted: undefined },
	]);
});
