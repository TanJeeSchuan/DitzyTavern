import { expect, test } from "bun:test";
import type { BoxSetups } from "../../shared/contract/box";
import { captureBoxes, fingerprintBoxes, type BoxRegistration } from "./registry";
import { moodBox } from "../../boxes/mood/server";
import { worldClockBox } from "../../boxes/world-clock/server";

test("a Phone contact added after inspection makes the plan stale", () => {
	const human = { id: 1, name: "Ann" };
	const capture = (cast: readonly { id: number; name: string }[]) => fingerprintBoxes(captureBoxes(
		[{ reference: "box:phone", enabled: true, role: "system", content: "" }],
		// SAFETY: Phone reads no setup.
		{} as BoxSetups,
		{ "author-note": "absent", memory: "absent", mood: "absent", phone: "enabled", race: "absent", thought: "absent", "world-clock": "absent" },
		{},
		{},
		{ seed: "seed", intent: "respond", human, cast, memory: () => { throw new Error("Phone reads no memory."); } },
	));
	expect(capture([human, { id: 2, name: "Bo" }])).not.toBe(capture([human, { id: 2, name: "Bo" }, { id: 3, name: "Cy" }]));
});

// @approved
//  A registration is checked against its own id's descriptor: the Mood Box's
//  record and setup are not the World Clock's.
export const registrations: readonly BoxRegistration<"world-clock">[] = [
	worldClockBox,
	// @ts-expect-error The Mood Box cannot register as the World Clock.
	moodBox,
];
