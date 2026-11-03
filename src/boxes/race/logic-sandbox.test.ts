import { expect, test } from "bun:test";
import { serverBox } from "../../server/box/registry";
import { advanceRace, foldRace } from "./logic-engine";
import { fillRaceField, initialRaceSetup } from "./shared-data";
import type { RaceRecord, RaceState } from "./shared";

// @approved
//  Records that copied the replay grew with the square of the Stretch count
// and passed the 4 MiB call limit long before 200 Stretches. Compact records
// fold that far in one sandboxed call: the state keeps the last record's
// standings and one replay entry per Stretch, in order.
test("200 Stretches of an 18-Runner race fold through the sandbox in one call within its limits", () => {
	const setup = { ...initialRaceSetup, raceId: "long", phase: "running" as const, metresPerStretch: 100, slots: fillRaceField([], [], "long", 18), course: { ...initialRaceSetup.course, distance: 3200 } };
	const raced: RaceRecord[] = [];
	let state: RaceState | null = null;
	for (let turn = advanceRace({ setup, state, seed: "s0", intent: "continue", moves: [] }); turn?.record !== undefined; turn = advanceRace({ setup, state, seed: `s${raced.length}`, intent: "continue", moves: [] })) {
		raced.push(turn.record);
		state = foldRace(state, turn.record, setup);
	}
	const stretches = raced.filter(({ entries }) => entries.length === 1);
	const records = Array.from({ length: 200 }, (_, index) => {
		const record = stretches[index % stretches.length]!; // @approved The race ran Stretches, so the list is not empty.
		return { ...record, stretch: index + 1, entries: record.entries.map((entry) => ({ ...entry, stretch: index + 1 })) };
	});
	const folded = serverBox("race")?.records?.foldAll?.(null, records, setup);
	expect(folded).toMatchObject({ stretch: 200, standings: records[199]!.standings });
	expect(JSON.stringify(folded)).toBe(JSON.stringify(records.reduce<RaceState | null>((current, record) => foldRace(current, record, setup), null)));
});
