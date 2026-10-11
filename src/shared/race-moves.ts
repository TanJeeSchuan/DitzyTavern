import type { RaceMove, RaceMoveKind, RaceSetup, RaceState } from "./contract/race";

// @approved
//  `cost` is energy spent when the Move resolves, refunded when negative.
//  `pace` is added to the Runner's pace for the Stretch when the Move succeeds.
export const raceMoveCatalog = {
	overtake: { icon: "⚡", label: "Overtake", cost: 0.12, pace: 0.06, intent: (runner: string) => `${runner} tries to overtake.` },
	conserve: { icon: "⏳", label: "Conserve", cost: -0.08, pace: -0.04, intent: (runner: string) => `${runner} conserves energy.` },
	spurt: { icon: "🔥", label: "Spurt", cost: 0.2, pace: 0.1, intent: (runner: string) => `${runner} launches a spurt.` },
	hold: { icon: "✋", label: "Hold", cost: 0, pace: 0, intent: () => "The race holds for this turn." },
} as const satisfies Record<RaceMoveKind, { icon: string; label: string; cost: number; pace: number; intent(runner: string): string }>;

export const raceMoveLabel = ({ kind, runner }: RaceMove): string => `${raceMoveCatalog[kind].icon} ${raceMoveCatalog[kind].label} · ${runner}`;

export type RaceMoveCheck = { readonly legal: true; readonly cost: number; readonly odds: number } | { readonly legal: false; readonly reason: string };

const clampOdds = (odds: number) => Math.round(Math.min(0.95, Math.max(0.05, odds)) * 100) / 100;

/** @approved One rule for the window's offer and the Stretch's resolution: `earlier` are the Moves staged or resolved before this one, whose costs it projects. */
export function checkRaceMove(setup: RaceSetup, state: RaceState, earlier: readonly RaceMove[], move: RaceMove): RaceMoveCheck {
	const { distance } = setup.course;
	if (setup.phase !== "running" || state.finished) return { legal: false, reason: "The race is not running." };
	if (state.metres >= distance) return { legal: false, reason: "The field has crossed the line." };
	if (setup.auto === "on" || (setup.auto !== "off" && state.metres < distance - setup.auto.until)) return { legal: false, reason: "Moves are off while Auto mode runs." };
	const index = state.standings.findIndex(({ name }) => name === move.runner);
	const runner = setup.slots.find(({ name }) => name === move.runner);
	if (index === -1 || runner === undefined) return { legal: false, reason: `${move.runner} is not racing.` };
	if (earlier.some(({ kind }) => kind === "hold")) return { legal: false, reason: "Hold skips this Stretch." };
	if (move.kind === "hold") return earlier.length === 0 ? { legal: true, cost: 0, odds: 1 } : { legal: false, reason: "Hold must be the only Move." };
	const energy = earlier.reduce((left, { kind, runner: name }) => name === move.runner ? left - raceMoveCatalog[kind].cost : left, state.standings[index]!.energy);
	const { cost } = raceMoveCatalog[move.kind];
	if (cost > energy) return { legal: false, reason: `${move.runner} lacks the energy.` };
	switch (move.kind) {
		case "conserve":
			return energy >= 1 ? { legal: false, reason: `${move.runner} is already fresh.` } : { legal: true, cost, odds: 1 };
		case "overtake": {
			const ahead = state.standings[index - 1];
			if (ahead === undefined) return { legal: false, reason: `${move.runner} already leads.` };
			const gap = ahead.distance - state.standings[index]!.distance;
			return { legal: true, cost, odds: clampOdds(0.7 - gap / 20 + (runner.power + runner.wit - 1200) / 4000) };
		}
		case "spurt":
			return state.metres < distance - 400
				? { legal: false, reason: "A spurt opens in the final 400 m." }
				: { legal: true, cost, odds: clampOdds(0.4 + runner.guts / 2000 + energy / 4) };
	}
}
