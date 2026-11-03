/* eslint-disable ditzy/no-contract-definition-outside-contract -- The lamp is a test Box with its own schemas. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Kind, Type, TypeRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { BoxDescriptor } from "../../shared/contract/box";
import type { GenerationJsonValue } from "../../shared/generation-json";
import { openObservedDatabase } from "../test-fixtures/conversation";
import type { CheckedBox, HostBox } from "./contract";
import { checkStoredBoxValues, clearHeldBoxValues } from "./schema-check";

// The lamp's schemas after an update: its setup renamed `on` to `lit`, which its upgrade rewrites.
const lamp: CheckedBox = {
	id: "lamp",
	descriptor: {
		id: "lamp", sdk: 2, label: "Lamp", summary: "A lamp.", instructions: "", role: "system", startsEnabled: false,
		setup: { schema: Type.Object({ lit: Type.Boolean() }), initial: { lit: false } },
		record: Type.Object({ glow: Type.Number() }),
		moves: { schema: Type.Object({ flick: Type.String() }), max: 3, label: () => "Flick" },
	} satisfies BoxDescriptor,
	box: {
		advance: { trace: Type.Object({ glow: Type.Number() }), run: async () => ({ items: [] }) },
		upgrade: (stored): GenerationJsonValue => {
			if (stored.kind === "move" && Value.Check(Type.Object({ flip: Type.String() }), stored.value)) return { flick: stored.value.flip };
			if (stored.kind !== "setup" || !Value.Check(Type.Object({ on: Type.Boolean() }), stored.value)) throw new Error("Nothing to upgrade.");
			return { lit: stored.value.on };
		},
	} satisfies HostBox,
};

let database: Database;
const value = (sql: string) => database.query<{ value: string }, []>(sql).get()?.value;
const entry = { items: [], automaticText: "", finalText: "" };

beforeEach(() => {
	database = openObservedDatabase();
	database.exec(`
		INSERT INTO conversation (id, name, creation_time, last_message_time) VALUES (1, 'Lamp', '2026-11-03', '2026-11-03');
		INSERT INTO messages (id, conversation_id, position, timestamp) VALUES (1, 1, 0, '2026-11-03');
		INSERT INTO message_variant (id, message_id, position, content, timestamp, selected) VALUES (1, 1, 0, 'Lit.', '2026-11-03', 1);
		INSERT INTO conversation_data (conversation_id, namespace, key, value) VALUES (1, 'box:lamp', 'setup', '{"on":true}');
		INSERT INTO messages_data (message_id, namespace, key, value) VALUES (1, 'box:lamp', 'moves', '[{"flick":"up"},{"flip":"down"},{"twist":1}]');
	`);
	const insert = database.query("INSERT INTO message_variant_data (message_variant_id, namespace, key, value) VALUES (1, ?, ?, ?)");
	insert.run("box:lamp", "record:a", JSON.stringify({ automatic: { brightness: 3 }, writer: { brightness: 5 }, source: "hash" }));
	insert.run("generation-box", "traces", JSON.stringify({ "box:lamp": { ...entry, trace: { brightness: 3 } }, "box:other": { ...entry, trace: { kept: true } } }));
});

afterEach(() => database.close());

test("a changed Box's values are upgraded, its derived values dropped, and what a person wrote held", () => {
	expect(checkStoredBoxValues(database, [lamp])).toEqual(new Map([["lamp", ["Message 1 Moves", "Variant 1 record writer"]]]));
	expect(value("SELECT value FROM conversation_data WHERE key = 'setup'")).toBe('{"lit":true}');
	expect(value("SELECT value FROM messages_data")).toBe('[{"flick":"up"},{"flick":"down"},{"twist":1}]');
	expect(JSON.parse(value("SELECT value FROM message_variant_data WHERE key = 'record:a'")!)).toEqual({ writer: { brightness: 5 } });
	expect(JSON.parse(value("SELECT value FROM message_variant_data WHERE key = 'traces'")!)).toEqual({ "box:lamp": entry, "box:other": { ...entry, trace: { kept: true } } });
	expect(database.query("SELECT revision FROM conversation").get()).toEqual({ revision: 1 });
	expect(database.query("SELECT * FROM box_schema").all()).toEqual([]);
});

test("clearing deletes the held values, after which the Box's values are not checked again until its schemas change", () => {
	checkStoredBoxValues(database, [lamp]);
	clearHeldBoxValues(database, lamp);
	expect(value("SELECT value FROM messages_data")).toBe('[{"flick":"up"},{"flick":"down"}]');
	expect(value("SELECT value FROM message_variant_data WHERE key = 'record:a'")).toBeUndefined();

	database.exec(`UPDATE conversation_data SET value = '{"on":false}' WHERE key = 'setup'`);
	expect(checkStoredBoxValues(database, [lamp])).toEqual(new Map());
	expect(value("SELECT value FROM conversation_data WHERE key = 'setup'")).toBe('{"on":false}');
	const changed = { ...lamp, descriptor: { ...lamp.descriptor, record: Type.Object({ glow: Type.Integer() }) } };
	checkStoredBoxValues(database, [changed]);
	expect(value("SELECT value FROM conversation_data WHERE key = 'setup'")).toBe('{"lit":false}');
});

test("an upgrade that changes its input in place still lands, and one returning a cycle neither lands nor stops the load", () => {
	const careless: CheckedBox = { ...lamp, box: { ...lamp.box, upgrade: (stored) => {
		if (stored.kind === "setup" && Value.Check(Type.Object({ on: Type.Boolean() }), stored.value)) return Object.assign(stored.value, { lit: stored.value.on });
		const looped = { glow: 1 };
		return Object.assign(looped, { self: looped });
	} } };
	expect(checkStoredBoxValues(database, [careless])).toEqual(new Map([["lamp", ["Message 1 Moves", "Variant 1 record writer"]]]));
	expect(value("SELECT value FROM conversation_data WHERE key = 'setup'")).toBe('{"on":true,"lit":true}');
	expect(JSON.parse(value("SELECT value FROM message_variant_data WHERE key = 'record:a'")!)).toEqual({ writer: { brightness: 5 } });
});

test("an interrupted Generation's pending record that no longer fits is dropped before recovery can write it", () => {
	database.exec(`
		INSERT INTO participant (id, conversation_id, name, position) VALUES (1, 1, 'Writer', 1), (2, 1, 'Maren', 2);
		INSERT INTO active_generation (id, conversation_id, message_id, variant_id, human_participant_id, model_participant_id, captured_model_name, started_at, box_records_json)
		VALUES (1, 1, 1, 1, 1, 2, 'Maren', '2026-11-03', '{"lamp":{"instance":"a","record":{"brightness":3}},"other":{"instance":"b","record":{"kept":true}}}');
	`);
	checkStoredBoxValues(database, [lamp]);
	expect(JSON.parse(value("SELECT box_records_json AS value FROM active_generation")!)).toEqual({ other: { instance: "b", record: { kept: true } } });
});

test("a Box whose schema throws is left unchecked without stopping the others", () => {
	const broken: CheckedBox = { ...lamp, id: "broken", descriptor: { ...lamp.descriptor, id: "broken", record: Type.Object({ glow: Type.Ref("missing") }) } };
	database.exec(`INSERT INTO message_variant_data (message_variant_id, namespace, key, value) VALUES (1, 'box:broken', 'record:a', '{"automatic":{"glow":1}}')`);
	expect(checkStoredBoxValues(database, [broken, lamp]).get("lamp")).toEqual(["Message 1 Moves", "Variant 1 record writer"]);
	expect(database.query("SELECT box_id FROM box_schema").all()).toEqual([]);
});

test("schemas differing only in their custom kind fingerprint apart", () => {
	TypeRegistry.Set("Even", (_, value) => Number.isInteger(value) && Number(value) % 2 === 0);
	TypeRegistry.Set("Odd", (_, value) => Number.isInteger(value) && Number(value) % 2 === 1);
	const counting = (kind: string): CheckedBox => ({ ...lamp, descriptor: { ...lamp.descriptor, setup: { schema: Type.Unsafe({ [Kind]: kind }), initial: 0 } } });
	database.exec(`UPDATE conversation_data SET value = '2' WHERE key = 'setup'`);
	expect(checkStoredBoxValues(database, [counting("Even")]).get("lamp")).not.toContain("Chat 1 setup");
	expect(checkStoredBoxValues(database, [counting("Odd")]).get("lamp")).toContain("Chat 1 setup");
});

test("returning to a Box's earlier schemas checks again after a check that held values", () => {
	const earlier: CheckedBox = {
		id: "lamp",
		descriptor: {
			...lamp.descriptor,
			setup: { schema: Type.Object({ on: Type.Boolean() }), initial: { on: false } },
			record: Type.Object({ brightness: Type.Number() }),
			moves: { schema: Type.Object({}), max: 3, label: () => "Flick" },
		},
		box: { advance: { trace: Type.Object({ brightness: Type.Number() }), run: async () => ({ items: [] }) } },
	};
	expect(checkStoredBoxValues(database, [earlier])).toEqual(new Map());
	checkStoredBoxValues(database, [lamp]);
	expect(checkStoredBoxValues(database, [earlier]).get("lamp")).toContain("Chat 1 setup");
});
