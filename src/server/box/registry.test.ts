import { expect, test } from "bun:test";
import type { BoxSetups } from "../../shared/contract/box";
import { captureBoxes, fingerprintBoxes } from "./registry";

test("a Phone contact added after inspection makes the plan stale", () => {
	const human = { id: 1, name: "Ann" };
	const capture = (cast: readonly { id: number; name: string }[]) => fingerprintBoxes(captureBoxes(
		[{ reference: "box:phone", enabled: true, role: "system" }],
		// SAFETY: Phone reads no setup.
		{} as BoxSetups,
		{ "author-note": "absent", memory: "absent", mood: "absent", phone: "enabled", race: "absent", thought: "absent", "world-clock": "absent" },
		{},
		{},
		{ seed: "seed", intent: "respond", human, cast, memory: () => { throw new Error("Phone reads no memory."); } },
	));
	expect(capture([human, { id: 2, name: "Bo" }])).not.toBe(capture([human, { id: 2, name: "Bo" }, { id: 3, name: "Cy" }]));
});
