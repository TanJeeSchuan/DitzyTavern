import { expect, test } from "bun:test";
import { fillRaceField, initialRaceSetup } from "../../shared/race-data";
import { raceBox } from "./race";
import { initialRaceState } from "./race-engine";

const setup = {
	...initialRaceSetup,
	raceId: "race-a",
	phase: "running" as const,
	slots: fillRaceField([], [], "field").map((runner, index) =>
		index < 2 ? { ...runner, participantId: 100 + index } : runner,
	),
};

test("a withdrawn Cast Runner leaves the field, and the item says so once", async () => {
	const withdrawn = setup.slots[0]!.name;
	const dependencies = { seed: "first", intent: "respond" as const, withdrawn: [withdrawn] };
	const first = await raceBox.advance!.run({ setup, state: null, dependencies, moves: [] });

	expect(first.items[0]!.text).toContain(`${withdrawn} is withdrawn.`);
	expect(first.record!.after.standings).toHaveLength(setup.slots.length - 1);
	expect(first.record!.after.standings.some(({ name }) => name === withdrawn)).toBe(false);

	const second = await raceBox.advance!.run({
		setup,
		state: first.record!.after,
		dependencies: { ...dependencies, seed: "second" },
		moves: [],
	});
	expect(second.items[0]!.text).not.toContain("is withdrawn.");
});

test("a Hold turn that loses a Runner persists the withdrawal, and the next Hold does not repeat it", async () => {
	const runner = setup.slots[0]!.name;
	const dependencies = { seed: "hold", intent: "respond" as const, withdrawn: [runner] };
	const first = await raceBox.advance!.run({
		setup: { ...setup, auto: "off" },
		state: null,
		dependencies,
		moves: [{ kind: "hold", runner: setup.slots[1]!.name }],
	});
	expect(first.items[0]!.text).toContain(`${runner} is withdrawn.`);
	expect(first.record!.after.standings.some(({ name }) => name === runner)).toBe(false);
	expect(first.record!.after.stretch).toBe(0);

	const second = await raceBox.advance!.run({
		setup: { ...setup, auto: "off" },
		state: first.record!.after,
		dependencies: { ...dependencies, seed: "hold-2" },
		moves: [{ kind: "hold", runner: setup.slots[1]!.name }],
	});
	expect(second.items[0]!.text).not.toContain("is withdrawn.");
});

test("a Runner withdrawn on a Hold forms no Hidden intent on the next Stretch", async () => {
	const field = { ...setup, auto: "off" as const, slots: setup.slots.map((runner, index) =>
		({ ...runner, style: index === 0 ? "End Closer" as const : "Front Runner" as const, wit: index === 0 ? 1500 : runner.wit })) };
	const runner = field.slots[0]!.name;
	const dependencies = { seed: "hold", intent: "respond" as const, withdrawn: [runner] };
	const hold = await raceBox.advance!.run({ setup: field, state: null, dependencies, moves: [{ kind: "hold", runner: field.slots[1]!.name }] });
	const next = await raceBox.advance!.run({ setup: field, state: hold.record!.after, dependencies: { ...dependencies, seed: "next" }, moves: [] });
	expect(next.record!.after.intents.some((planned) => planned.runner === runner)).toBe(false);
	expect(next.items[0]!.text).not.toContain("is withdrawn.");
});

test("a paused continuation still announces and persists a withdrawal", async () => {
	const runner = setup.slots[0]!.name;
	const result = await raceBox.advance!.run({
		setup: { ...setup, auto: "off" },
		state: null,
		dependencies: { seed: "paused", intent: "continue" as const, withdrawn: [runner] },
		moves: [],
	});
	expect(result.items[0]!.text).toContain(`${runner} is withdrawn.`);
	expect(result.record!.after.standings.some(({ name }) => name === runner)).toBe(false);
});

test("a field reduced below two Runners finishes with a default winner", async () => {
	const two = { ...setup, slots: setup.slots.slice(0, 2) };
	const withdrawn = two.slots[0]!;
	const winner = two.slots[1]!;
	const record = await raceBox.advance!.run({
		setup: two,
		state: null,
		dependencies: { seed: "walkover", intent: "respond" as const, withdrawn: [withdrawn.name] },
		moves: [],
	});
	expect(record.items[0]!.text).toContain(`${withdrawn.name} is withdrawn.`);
	expect(record.items[0]!.text).toContain(`${winner.name} wins by default.`);
	expect(record.record!.after.finished).toBe(true);
	expect(record.record!.after.standings.map(({ name }) => name)).toEqual([winner.name]);
});

test("a Hold cannot skip the walkover when the field is below two", async () => {
	const two = { ...setup, slots: setup.slots.slice(0, 2), auto: "off" as const };
	const record = await raceBox.advance!.run({
		setup: two,
		state: null,
		dependencies: { seed: "hold-walkover", intent: "respond" as const, withdrawn: [two.slots[0]!.name] },
		moves: [{ kind: "hold", runner: two.slots[1]!.name }],
	});
	expect(record.record!.after.finished).toBe(true);
});

test("a walkover settles the surviving Runner's open Hidden intent", async () => {
	const two = { ...setup, slots: setup.slots.slice(0, 2) };
	const survivor = two.slots[1]!;
	const state = { ...initialRaceState(two), stretch: 1, metres: 400, intents: [{ runner: survivor.name, formed: 1, payoff: null }] };
	const record = await raceBox.advance!.run({
		setup: two,
		state,
		dependencies: { seed: "intent", intent: "respond" as const, withdrawn: [two.slots[0]!.name] },
		moves: [],
	});
	expect(record.record!.after.intents).toEqual([{ runner: survivor.name, formed: 1, payoff: 2 }]);
});

test("a Participant that is still in the Cast is not withdrawn", async () => {
	const runner = setup.slots[0]!;
	const record = await raceBox.advance!.run({
		setup,
		state: null,
		dependencies: { seed: "intact", intent: "respond" as const, withdrawn: [] },
		moves: [],
	});
	expect(record.items[0]!.text).not.toContain("is withdrawn.");
	expect(record.record!.after.standings).toHaveLength(setup.slots.length);
});
