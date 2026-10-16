import { expect, test } from "bun:test";
import type { RaceRunner } from "./contract";
import { addRaceRunner, rollRaceStats } from "./shared-data";

const draw = (...values: number[]) => {
	let index = 0;
	return () => values[index++]!;
};

test("a stat roll is biased toward the Running style and stays in range", () => {
	expect(rollRaceStats("Front Runner", draw(0, 0, 0, 0, 0))).toEqual({
		style: "Front Runner", speed: 550, stamina: 450, power: 450, guts: 450, wit: 450,
	});
	expect(rollRaceStats("Pace Chaser", draw(1, 1, 1, 1, 1)).stamina).toBe(850);
	expect(rollRaceStats("Late Surger", draw(1, 1, 1, 1, 1)).power).toBe(850);
	expect(rollRaceStats("End Closer", draw(1, 1, 1, 1, 1)).guts).toBe(850);
	expect(rollRaceStats("End Closer", draw(1, 1, 1, 1, 1)).speed).toBe(750);
});

test("adding a Cast Runner replaces a roster Runner of the same name and never doubles a Participant", () => {
	const roster: RaceRunner = { name: "Special Week", style: "Pace Chaser", speed: 1, stamina: 1, power: 1, guts: 1, wit: 1 };
	const other: RaceRunner = { ...roster, name: "Silence Suzuka", participantId: 7 };
	const cast: RaceRunner = { ...roster, name: "  special week ", style: "Late Surger", participantId: 42 };
	expect(addRaceRunner([roster, other], cast)).toEqual([other, cast]);
	expect(addRaceRunner([other, cast], cast)).toEqual([other, cast]);
});
