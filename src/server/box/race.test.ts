import { expect, test } from "bun:test";
import type { RaceMove, RaceRecord, RaceState } from "../../shared/contract/race";
import { fillRaceField, initialRaceSetup } from "../../shared/race-data";
import { advanceRace, foldRace } from "./race-engine";

const foldRaceRecords = (records: readonly RaceRecord[], raceId: string) => records.reduce<RaceState | null>((state, record) => foldRace(state, record, { raceId }), null);
const setup = { ...initialRaceSetup, raceId: "race-a", phase: "running" as const, slots: fillRaceField([], [], "field") };

test("equal Race state and seed produce the same Stretch without mutating inputs", () => {
	const input = { setup, state: null, seed: "stretch-one", intent: "respond" as const, moves: [] };
	const before = structuredClone(input);
	const first = advanceRace(input)!;
	expect(first.after.metres).toBe(400);
	expect(first.after.standings).toHaveLength(8);
	expect(advanceRace(input)).toEqual(first);
	expect(input).toEqual(before);
	expect(advanceRace({ ...input, seed: "rerolled" })!.outcome).not.toBe(first.outcome);
});

test("the last 400 metres shorten to 100-metre Stretches, followed by one Results Stretch", () => {
	let state: RaceState | null = null;
	const ends: number[] = [];
	for (let i = 0; i < 20; i++) {
		const record = advanceRace({ setup, state, seed: `stretch-${i}`, intent: "continue", moves: [] });
		if (!record) break;
		state = record.after;
		ends.push(state.metres);
		if (state.finished) expect(record.outcome).toContain("Narrate the finish.");
	}
	expect(ends).toEqual([400, 800, 1200, 1600, 2000, 2100, 2200, 2300, 2400, 2400]);
	expect(state?.finished).toBe(true);
	expect(advanceRace({ setup, state, seed: "after-finish", intent: "respond", moves: [] })).toBeUndefined();
});

test("resolved later Stretches survive earlier selections and a new race starts from zero", () => {
	const first = advanceRace({ setup, state: null, seed: "first", intent: "respond", moves: [] })!;
	const second = advanceRace({ setup, state: first.after, seed: "second", intent: "respond", moves: [] })!;
	const rerolled = advanceRace({ setup, state: null, seed: "other-first", intent: "respond", moves: [] })!;
	expect(foldRaceRecords([rerolled, second], "race-a")?.metres).toBe(800);
	const next = advanceRace({ setup: { ...setup, raceId: "race-b" }, state: second.after, seed: "first", intent: "respond", moves: [] })!;
	expect(next.after.metres).toBe(400);
	expect(next.stretch).toBe(1);
	expect(foldRaceRecords([first, next, second], "race-b")?.metres).toBe(400);
	expect(foldRaceRecords([first, next, second], "race-a")?.metres).toBe(800);
	expect(foldRaceRecords([first, next, second], "race-c")).toBeNull();
});

test("respond advances with Auto off; both intents stop at the configured distance from the finish, and respond advances past it", () => {
	const off = { ...setup, auto: "off" as const };
	expect(advanceRace({ setup: off, state: null, seed: "a", intent: "continue", moves: [] })).toBeUndefined();
	expect(advanceRace({ setup: off, state: null, seed: "a", intent: "respond", moves: [] })?.after.metres).toBe(400);
	const until = { ...setup, auto: { until: 2100 } };
	const first = advanceRace({ setup: until, state: null, seed: "a", intent: "continue", moves: [] })!;
	expect(first.after.metres).toBe(300);
	expect(advanceRace({ setup: until, state: first.after, seed: "b", intent: "continue", moves: [] })).toBeUndefined();
	expect(advanceRace({ setup: until, state: first.after, seed: "b", intent: "respond", moves: [] })?.after.metres).toBe(700);
	expect(advanceRace({ setup: until, state: null, seed: "a", intent: "respond", moves: [] })?.after.metres).toBe(300);
});

test("a Move's pace lasts its 100 m however long the Stretch", () => {
	// @approved The Pace Chasers draw the same numbers with or without the Overtake, and the faster one leads and times every step, so the time it saves is the Move alone.
	const stats = { style: "Pace Chaser" as const, stamina: 1200, power: 600, guts: 600, wit: 1200 };
	const slots = [{ name: "Slow", ...stats, speed: 1 }, { name: "Fast", ...stats, speed: 1200 }];
	const saved = (metresPerStretch: number) => {
		const input = { setup: { ...setup, slots, auto: "off" as const, metresPerStretch }, state: null, seed: "pace", intent: "respond" as const };
		const moved = advanceRace({ ...input, moves: [{ kind: "overtake", runner: "Fast" }] })!.after;
		expect(moved.replay[0]!.runners.find(({ name }) => name === "Fast")!.decisions).toEqual([{ kind: "overtake", writer: true, success: true }]);
		return advanceRace({ ...input, moves: [] })!.after.standings[0]!.time - moved.standings[0]!.time;
	};
	expect(saved(1500) / saved(400)).toBeCloseTo(1, 1);
});

test("Fill field is seeded, preserves slots, and excludes names already in the Cast", () => {
	const slots = setup.slots.slice(0, 2);
	const filled = fillRaceField(slots, ["Special Week", "Silence Suzuka"], "field-two");
	expect(filled).toEqual(fillRaceField(slots, ["Special Week", "Silence Suzuka"], "field-two"));
	expect(filled.slice(0, 2)).toEqual(slots);
	expect(filled.slice(2).some(({ name }) => name === "Special Week" || name === "Silence Suzuka")).toBe(false);
	expect(new Set(filled.map(({ name }) => name)).size).toBe(8);
});

test("Auto until the finish still contributes a Results Stretch", () => {
	const untilFinish = { ...setup, course: { ...setup.course, distance: 400 }, auto: { until: 0 } };
	let state: RaceState | null = null;
	const outcomes: string[] = [];
	for (let i = 0; i < 6; i++) {
		const record = advanceRace({ setup: untilFinish, state, seed: `finish-${i}`, intent: "continue", moves: [] });
		if (record === undefined) break;
		state = record.after;
		outcomes.push(record.outcome);
	}
	expect(outcomes).toHaveLength(5);
	expect(outcomes.at(-1)).toContain("Narrate the finish.");
	expect(state?.finished).toBe(true);
});

test("Moves resolve in order against projected energy and per-Runner limits, the same for equal state, Moves and seed", () => {
	const runner = setup.slots[1]!.name;
	const input = { setup: { ...setup, auto: "off" as const }, state: null, seed: "moves", intent: "respond" as const,
		moves: [{ kind: "conserve" as const, runner }, { kind: "overtake" as const, runner }, { kind: "conserve" as const, runner }, { kind: "spurt" as const, runner }] };
	const record = advanceRace(input)!;
	expect(advanceRace(input)).toEqual(record);
	const lines = record.outcome.split("\n").filter((line) => line.includes(` · ${runner}: `));
	expect(lines[0]).toBe(`⏳ Conserve · ${runner}: fizzles. ${runner} is already fresh.`);
	expect(lines[1]).toMatch(/^⚡ Overtake · .*: (succeeds|fizzles)\./);
	expect(lines[2]).toMatch(/^⏳ Conserve · .*: succeeds\./);
	expect(lines[3]).toBe(`🔥 Spurt · ${runner}: fizzles. ${runner} already attacks this Stretch.`);
	const held = advanceRace({ ...input, moves: [{ kind: "hold", runner }, { kind: "overtake", runner }] })!.outcome;
	expect(held).toContain(`✋ Hold · ${runner}: fizzles. Hold must be the only Move.`);
	expect(held).toMatch(/⚡ Overtake · .*: (succeeds|fizzles)\. .*(surges|boxed in)/);
	expect(advanceRace({ ...input, setup })!.outcome).toContain(`⚡ Overtake · ${runner}: fizzles. Moves are off while Auto mode runs.`);
});

const runRace = (fields: { setup: typeof setup; moves?: (state: RaceState | null) => RaceMove[] }) => {
	let state: RaceState | null = null;
	const outcomes: string[] = [];
	const ordered: RaceMove[][] = [];
	for (let i = 0; i < 30 && state?.finished !== true; i++) {
		const input = { setup: fields.setup, state, seed: `${fields.setup.raceId}-${i}`, intent: "respond" as const, moves: fields.moves?.(state) ?? [] };
		const record: RaceRecord = advanceRace(input)!;
		state = record.after;
		outcomes.push(record.outcome);
		ordered.push(input.moves);
	}
	return { state: state!, outcomes, ordered };
};

test("no Hidden intent stays unrevealed after the Results Stretch, and each pays off on its first successful charge", () => {
	const races = Array.from({ length: 12 }, (_, index) => ({ ...setup, raceId: `intent-${index}`, auto: "off" as const, slots: fillRaceField([], [], `intent-field-${index}`) }));
	const checked = races.flatMap((race) => {
		// @approved Ordering a planned closer to conserve every turn keeps the engine from launching its charge, so its reveal falls to the Results Stretch.
		const unspent = race.raceId.endsWith("0") || race.raceId.endsWith("5");
		const { state, outcomes, ordered } = runRace({ setup: race, moves: (current) => unspent && current !== null && current.intents[0] !== undefined
			? [{ kind: "conserve", runner: current.intents[0].runner }] : [] });
		expect(state.replay).toHaveLength(outcomes.length - 1);
		return state.intents.map(({ runner, formed, payoff }) => {
			expect(payoff).not.toBeNull();
			const charged = state.replay.map(({ runners }) => runners.find(({ name }) => name === runner)!.decisions.some(({ kind, success }) => kind === "spurt" && success));
			expect(charged.indexOf(true) + 1 || outcomes.length).toBe(payoff!);
			outcomes.forEach((outcome, index) => {
				const stretch = index + 1;
				const hinted = stretch >= formed && stretch < payoff! && !outcome.split("\n")[1]!.endsWith("last spurt") && !ordered[index]!.some((move) => move.runner === runner);
				expect(outcome.includes(`Reveal now: ${runner} `)).toBe(stretch === payoff);
				expect(outcome.includes(`Foreshadow, do not reveal: ${runner} `)).toBe(hinted);
			});
			return outcomes[payoff! - 1]!.includes("Results Stretch") ? "results" : "charge";
		});
	});
	expect(new Set(checked)).toEqual(new Set(["results", "charge"]));
});

test("salient events favour Cast Runners", () => {
	const quiet = setup.slots[5]!.name;
	const mentions = (race: typeof setup) => runRace({ setup: race }).outcomes
		.filter((outcome) => outcome.split("\n").some((line) => line.startsWith(quiet))).length;
	const cast = { ...setup, slots: setup.slots.map((slot, index) => index === 5 ? { ...slot, participantId: 1 } : slot) };
	expect(mentions(cast)).toBeGreaterThan(mentions(setup));
});
