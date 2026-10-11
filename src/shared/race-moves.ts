import type { RaceMove, RaceMoveKind, RaceSetup, RaceSpectatorState } from "./contract/race";

/** @approved Below this energy a Runner tires and loses pace, so no attack may spend into it. */
export const FATIGUE_ENERGY = 0.35;
/** @approved A Move's pace change lasts this far into its Stretch, so its effect does not grow with the Stretch length. */
export const MOVE_METRES = 100;
export const MAX_RACE_MOVES = 12;

// @approved
//  `cost` is energy spent when the Move resolves, refunded when negative.
//  `pace` is added to the Runner's pace for the first MOVE_METRES of the
//  Stretch when the Move succeeds. Energy and pace trade at about 1 m of
//  ground per 0.01 energy, so Conserve banks what an attack later spends.
export const raceMoveCatalog = {
	overtake: {
		icon: "⚡", label: "Overtake", cost: 0.08, pace: 0.15,
		intent: (runner: string) => `${runner} tries to overtake.`, effect: (runner: string) => `${runner} surges for ${MOVE_METRES} m.`,
	},
	conserve: {
		icon: "⏳", label: "Conserve", cost: -0.06, pace: -0.06,
		intent: (runner: string) => `${runner} conserves energy.`, effect: (runner: string) => `${runner} eases off for ${MOVE_METRES} m and recovers energy.`,
	},
	spurt: {
		icon: "🔥", label: "Spurt", cost: 0.12, pace: 0.2,
		intent: (runner: string) => `${runner} launches a spurt.`, effect: (runner: string) => `${runner} kicks for ${MOVE_METRES} m.`,
	},
	hold: { icon: "✋", label: "Hold", cost: 0, pace: 0, intent: () => "The race holds for this turn.", effect: () => "The race does not advance this turn." },
} as const satisfies Record<RaceMoveKind, { icon: string; label: string; cost: number; pace: number; intent(runner: string): string; effect(runner: string): string }>;

export const raceMoveLabel = ({ kind, runner }: RaceMove): string => `${raceMoveCatalog[kind].icon} ${raceMoveCatalog[kind].label} · ${runner}`;

/** @approved Energy after a Move resolves; resolution and projection both cap it to [0, 1]. */
export const spendEnergy = (energy: number, kind: RaceMoveKind): number => Math.min(1, Math.max(0, energy - raceMoveCatalog[kind].cost));

export type RunnerMoveKind = Exclude<RaceMoveKind, "hold">;
export type RaceMoveCheck = { readonly legal: true; readonly cost: number; readonly odds: number } | { readonly legal: false; readonly reason: string };

const clampOdds = (odds: number) => Math.round(Math.min(0.95, Math.max(0.05, odds)) * 100) / 100;
const isAttack = (kind: RaceMoveKind) => kind === "overtake" || kind === "spurt";

/** @approved One rule for the window's offer and the Stretch's resolution: `earlier` are the Moves staged or resolved before this one, whose costs it projects. */
export function checkRaceMove(setup: RaceSetup, state: RaceSpectatorState, earlier: readonly RaceMove[], move: RaceMove): RaceMoveCheck {
	const { distance } = setup.course;
	if (setup.phase !== "running" || state.finished) return { legal: false, reason: "The race is not running." };
	if (state.metres >= distance) return { legal: false, reason: "The field has crossed the line." };
	if (setup.auto === "on" || (setup.auto !== "off" && state.metres < distance - setup.auto.until)) return { legal: false, reason: "Moves are off while Auto mode runs." };
	if (!state.standings.some(({ name }) => name === move.runner) || !setup.slots.some(({ name }) => name === move.runner)) return { legal: false, reason: `${move.runner} is not racing.` };
	if (earlier.length >= MAX_RACE_MOVES) return { legal: false, reason: `A turn holds at most ${MAX_RACE_MOVES} Moves.` };
	if (earlier.some(({ kind }) => kind === "hold")) return { legal: false, reason: "Hold skips this Stretch." };
	if (move.kind === "hold") return earlier.length === 0 ? { legal: true, cost: 0, odds: 1 } : { legal: false, reason: "Hold must be the only Move." };
	return checkRunnerMove(setup, state, earlier, move.runner, move.kind);
}

/** @approved The rule for one Runner's attack or easing, shared by the writer's Moves and the engine's own decisions. */
export function checkRunnerMove(setup: RaceSetup, state: RaceSpectatorState, earlier: readonly RaceMove[], name: string, kind: RunnerMoveKind): RaceMoveCheck {
	const { distance } = setup.course;
	const index = state.standings.findIndex((standing) => standing.name === name);
	const runner = setup.slots.find((slot) => slot.name === name)!;
	const own = earlier.filter((move) => move.runner === name);
	if (own.some((move) => isAttack(kind) ? isAttack(move.kind) : move.kind === kind)) {
		return { legal: false, reason: `${name} already ${isAttack(kind) ? "attacks" : "eases off"} this Stretch.` };
	}
	const energy = own.reduce((left, move) => spendEnergy(left, move.kind), state.standings[index]!.energy);
	const { cost } = raceMoveCatalog[kind];
	switch (kind) {
		case "conserve":
			return energy - cost > 1 ? { legal: false, reason: `${name} is already fresh.` } : { legal: true, cost, odds: 1 };
		case "overtake": {
			if (energy - cost < FATIGUE_ENERGY) return { legal: false, reason: `${name} is too tired to attack.` };
			const ahead = state.standings[index - 1];
			if (ahead === undefined) return { legal: false, reason: `${name} already leads.` };
			// @approved The odds reach their floor near the ground one surge gains, so a Runner far behind cannot pass.
			const gap = ahead.distance - state.standings[index]!.distance;
			return { legal: true, cost, odds: clampOdds(0.75 - gap / 15 + (runner.power + runner.wit - 1200) / 4000) };
		}
		case "spurt":
			if (energy - cost < FATIGUE_ENERGY) return { legal: false, reason: `${name} is too tired to attack.` };
			return state.metres < distance - 400
				? { legal: false, reason: "A spurt opens in the final 400 m." }
				: { legal: true, cost, odds: clampOdds(0.4 + runner.guts / 2000 + energy / 4) };
	}
}
