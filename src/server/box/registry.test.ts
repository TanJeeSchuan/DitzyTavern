import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { captureBoxes, fingerprintBoxes } from "./registry";

test("a Phone contact added after inspection makes the plan stale", () => {
	const human = { id: 1, name: "Ann" };
	const capture = (cast: readonly { id: number; name: string }[]) => fingerprintBoxes(captureBoxes(
		[{ reference: "box:phone", enabled: true, role: "system", content: "" }],
		{},
		{ "author-note": "absent", memory: "absent", mood: "absent", phone: "enabled", race: "absent", thought: "absent", "world-clock": "absent" },
		{},
		{},
		// SAFETY: Phone reads nothing through the database.
		{ database: {} as Database, conversationId: 1, seed: "seed", intent: "respond", human, cast, messages: [], pending: undefined },
	));
	expect(capture([human, { id: 2, name: "Bo" }])).not.toBe(capture([human, { id: 2, name: "Bo" }, { id: 3, name: "Cy" }]));
});
