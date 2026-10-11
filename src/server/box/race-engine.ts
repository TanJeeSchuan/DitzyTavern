import type { RaceInput, RaceMove, RaceRecord, RaceSetup, RaceState, RunningStyle } from "../../shared/contract/race";
import { raceRandom } from "../../shared/race-data";
import { checkRaceMove, FATIGUE_ENERGY, MOVE_METRES, raceMoveCatalog, raceMoveLabel, spendEnergy } from "../../shared/race-moves";

export const initialRaceState = (setup: RaceSetup): RaceState => ({
	raceId: setup.raceId, stretch: 0, metres: 0, finished: false,
	standings: setup.slots.map(({ name }) => ({ name, distance: 0, energy: 1, time: 0 })),
});

export const foldRaceRecords = (records: readonly RaceRecord[], raceId: string): RaceState | null =>
	records.reduce<RaceState | null>((state, record) => record.raceId === raceId ? foldRace(state, record) : state, null);

export const foldRace = (_state: RaceState | null, record: RaceRecord): RaceState => record.after;

const stylePace = {
	"Front Runner": [1.08, 1.03, 0.99, 0.97],
	"Pace Chaser": [1.03, 1.02, 1.03, 1.01],
	"Late Surger": [0.97, 1, 1.07, 1.08],
	"End Closer": [0.94, 0.98, 1.04, 1.15],
} satisfies Record<RunningStyle, readonly number[]>;
const phaseAt = (metres: number, distance: number): number =>
	metres >= distance - 400 ? 3 : metres >= distance * 0.7 ? 2 : metres >= distance / 6 ? 1 : 0;
const phases = ["opening", "middle", "final corner", "last spurt"];
const ordinal = (rank: number) => `${rank}${rank === 1 ? "st" : rank === 2 ? "nd" : rank === 3 ? "rd" : "th"}`;

export const raceStatus = (setup: RaceSetup, state: RaceState | null): string | null => {
	if (setup.phase === "setup") return null;
	const current = state?.raceId === setup.raceId ? state : initialRaceState(setup);
	if (current.finished) return `🏁 1st · ${current.standings[0]?.name ?? ""}`;
	// @approved Until Cast slotting, the dock follows the Runner in the first gate.
	const rank = current.standings.findIndex(({ name }) => name === setup.slots[0]?.name) + 1;
	return `🏇 ${current.metres}m · ${ordinal(rank)}`;
};

export const currentRaceState = (setup: RaceSetup, state: RaceState | null): RaceState => state?.raceId === setup.raceId ? state : initialRaceState(setup);

export function advanceRace({ setup, state, seed, intent, moves }: RaceInput): RaceRecord | undefined {
	const before = currentRaceState(setup, state);
	if (setup.phase !== "running" || before.finished || setup.slots.length < 2) return undefined;
	if (intent === "continue" && (setup.auto === "off" || (setup.auto !== "on" && setup.auto.until > 0 && before.metres >= setup.course.distance - setup.auto.until))) return undefined;
	const stretch = before.stretch + 1;
	const course = `${setup.course.name} · ${setup.course.distance} m · ${setup.course.surface} · ${setup.course.direction}-handed`;
	if (before.metres >= setup.course.distance) {
		const winner = before.standings[0]!;
		const order = before.standings.map((runner, index) => `${index + 1}. ${runner.name} — ${index === 0 ? `${runner.time.toFixed(2)} s` : `+${(runner.time - winner.time).toFixed(2)} s`}`);
		const report = moves.map((move) => `${raceMoveLabel(move)}: fizzles. The race is over.`);
		return { raceId: setup.raceId, stretch, outcome: [course, "Results Stretch", ...order, ...report, "Narrate the finish."].join("\n"), after: { ...before, stretch, finished: true } };
	}
	const random = raceRandom(seed);
	const standings = structuredClone(before.standings);
	const pace = new Map<string, number>();
	const resolved: RaceMove[] = [];
	const report = moves.map((move) => {
		// @approved A Hold that is not alone fizzles and lets the rest resolve; alone it never reaches the engine.
		const check = move.kind === "hold" && moves.length > 1 ? { legal: false as const, reason: "Hold must be the only Move." } : checkRaceMove(setup, before, resolved, move);
		if (!check.legal) return { move, fizzle: check.reason };
		resolved.push(move);
		const position = standings.find(({ name }) => name === move.runner)!;
		position.energy = spendEnergy(position.energy, move.kind);
		if (random() >= check.odds) return { move, fizzle: `${move.runner} ${move.kind === "overtake" ? "is boxed in" : "finds nothing extra"}.` };
		pace.set(move.runner, (pace.get(move.runner) ?? 0) + raceMoveCatalog[move.kind].pace);
		return { move, fizzle: null };
	});
	const finalStart = setup.course.distance - 400;
	let end = Math.min(setup.course.distance, before.metres + (before.metres >= finalStart ? Math.min(100, setup.metresPerStretch) : setup.metresPerStretch));
	if (before.metres < finalStart) end = Math.min(end, finalStart);
	if (intent === "continue" && setup.auto !== "off" && setup.auto !== "on") end = Math.min(end, setup.course.distance - setup.auto.until);
	const runners = new Map(setup.slots.map((runner) => [runner.name, runner]));
	const stepMetres = (end - before.metres) / 20;
	for (let step = 0; step < 20; step++) {
		const phase = phaseAt(before.metres + step * stepMetres, setup.course.distance);
		const leader = Math.max(...standings.map((runner) => runner.distance));
		const speeds = standings.map((position) => {
			const runner = runners.get(position.name)!;
			const fatigue = Math.max(0, FATIGUE_ENERGY - position.energy) * (1 - runner.guts / 1600);
			const chase = Math.min(0.04, (leader - position.distance) / 1000) * runner.wit / 1200;
			return (14 + runner.speed / 180 + runner.power / 900 * (phase >= 2 ? 1 : 0.3))
				* (stylePace[runner.style][phase]! + (step * stepMetres < MOVE_METRES ? pace.get(position.name) ?? 0 : 0) + chase - fatigue + (random() - 0.5) * (0.12 - runner.wit / 20000));
		});
		const seconds = Math.min(...standings.map((runner, index) => (leader + stepMetres - runner.distance) / speeds[index]!));
		for (const [index, position] of standings.entries()) {
			const runner = runners.get(position.name)!;
			position.distance += speeds[index]! * seconds;
			position.time += seconds;
			position.energy = Math.max(0, position.energy - seconds / (100 + runner.stamina / 3) * (phase === 3 ? 1.5 : 1));
			if (end === setup.course.distance && step === 19) position.time += Math.max(0, end - position.distance) / speeds[index]!;
		}
	}
	standings.sort((a, b) => end === setup.course.distance ? a.time - b.time : b.distance - a.distance);
	const leader = standings[0]!;
	const previousLeader = before.standings[0]!;
	const mover = [...standings].sort((a, b) =>
		(before.standings.findIndex((runner) => runner.name === b.name) - standings.indexOf(b))
		- (before.standings.findIndex((runner) => runner.name === a.name) - standings.indexOf(a)))[0]!;
	const events = [
		before.metres === 0 ? `${leader.name} takes the early lead.` : leader.name === previousLeader.name ? `${leader.name} holds the lead.` : `${leader.name} passes ${previousLeader.name} for the lead.`,
		`${mover.name} runs ${ordinal(standings.indexOf(mover) + 1)} as the field enters the ${phases[phaseAt(end, setup.course.distance)]}.`,
		`${standings.at(-1)!.name} trails by ${(leader.distance - standings.at(-1)!.distance).toFixed(1)} m.`,
	];
	const order = standings.map((runner, index) => `${index + 1}. ${runner.name} — ${index === 0 ? "leader" : `+${(leader.distance - runner.distance).toFixed(1)} m`}`);
	const rank = (list: readonly { name: string }[], name: string) => ordinal(list.findIndex((runner) => runner.name === name) + 1);
	const moveLines = [
		...report.map(({ move, fizzle }) => `${raceMoveLabel(move)}: ${fizzle !== null ? `fizzles. ${fizzle}` : `succeeds. ${raceMoveCatalog[move.kind].effect(move.runner)}`}`),
		...[...new Set(resolved.map(({ runner }) => runner))].map((runner) => {
			const [from, to] = [rank(before.standings, runner), rank(standings, runner)];
			return from === to ? `${runner} holds ${to}.` : `${runner} goes from ${from} to ${to}.`;
		}),
	];
	const outcome = [course, `Stretch ${stretch}: ${before.metres}–${end} m`, ...order, ...events, ...moveLines, `Narrate only this Stretch. Do not go past ${end} m.`].join("\n");
	return { raceId: setup.raceId, stretch, outcome, after: { raceId: setup.raceId, stretch, metres: end, finished: false, standings } };
}
