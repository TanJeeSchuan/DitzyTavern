import { expect, test } from "bun:test";
import { captureBoxes, fingerprintBoxes, participatingBoxes } from "../../server/box/registry";
import { openObservedDatabase } from "../../server/test-fixtures/conversation";

test("a Phone contact added after inspection makes the plan stale", () => {
	const database = openObservedDatabase();
	try {
		const human = { id: 1, name: "Ann" };
		const capture = (cast: readonly { id: number; name: string }[]) => fingerprintBoxes(captureBoxes(
			participatingBoxes([{ reference: "box:phone", enabled: true, role: "system", content: "" }], { phone: { state: "enabled", instance: "instance" } }),
			{},
			{},
			{},
			{ database, conversationId: 1, seed: "seed", intent: "respond", human, cast, messages: [], pending: undefined },
		));
		expect(capture([human, { id: 2, name: "Bo" }])).not.toBe(capture([human, { id: 2, name: "Bo" }, { id: 3, name: "Cy" }]));
	} finally { database.close(); }
});
