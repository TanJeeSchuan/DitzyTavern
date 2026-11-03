/* eslint-disable ditzy/no-contract-definition-outside-contract -- The lamp is a test Box with its own schemas. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { BoxDescriptor } from "../../shared/contract/box";
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
		moves: { schema: Type.Object({ flick: Type.String() }), max: 2, label: () => "Flick" },
	} satisfies BoxDescriptor,
	box: {
		advance: { trace: Type.Object({ glow: Type.Number() }), run: async () => ({ items: [] }) },
		upgrade: (stored) => {
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
		INSERT INTO messages_data (message_id, namespace, key, value) VALUES (1, 'box:lamp', 'moves', '[{"flick":"up"},{"twist":1}]');
	`);
	const insert = database.query("INSERT INTO message_variant_data (message_variant_id, namespace, key, value) VALUES (1, ?, ?, ?)");
	insert.run("box:lamp", "record:a", JSON.stringify({ automatic: { brightness: 3 }, writer: { brightness: 5 }, source: "hash" }));
	insert.run("generation-box", "traces", JSON.stringify({ "box:lamp": { ...entry, trace: { brightness: 3 } }, "box:other": { ...entry, trace: { kept: true } } }));
});

afterEach(() => database.close());

test("a changed Box's values are upgraded, its derived values dropped, and what a person wrote held", () => {
	expect(checkStoredBoxValues(database, [lamp])).toEqual(new Map([["lamp", ["Message 1 Moves", "Variant 1 record writer"]]]));
	expect(value("SELECT value FROM conversation_data WHERE key = 'setup'")).toBe('{"lit":true}');
	expect(value("SELECT value FROM messages_data")).toBe('[{"flick":"up"},{"twist":1}]');
	expect(JSON.parse(value("SELECT value FROM message_variant_data WHERE key = 'record:a'")!)).toEqual({ writer: { brightness: 5 } });
	expect(JSON.parse(value("SELECT value FROM message_variant_data WHERE key = 'traces'")!)).toEqual({ "box:lamp": entry, "box:other": { ...entry, trace: { kept: true } } });
	expect(database.query("SELECT revision FROM conversation").get()).toEqual({ revision: 1 });
	expect(database.query("SELECT * FROM box_schema").all()).toEqual([]);
});

test("clearing deletes the held values, after which the Box's values are not checked again until its schemas change", () => {
	checkStoredBoxValues(database, [lamp]);
	clearHeldBoxValues(database, lamp);
	expect(value("SELECT value FROM messages_data")).toBeUndefined();
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
