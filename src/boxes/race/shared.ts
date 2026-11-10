// @approved
//  The Race's types, as `descriptor.json` declares its schemas, and the Move
// rules the logic and the window share. The host checks every value against
// the descriptor, so a type here that drifts from it fails loudly.
export const runningStyles = ["Front Runner", "Pace Chaser", "Late Surger", "End Closer"] as const;
export type RunningStyle = typeof runningStyles[number];
export type RaceCourse = { name: string; distance: number; surface: "turf" | "dirt"; direction: "left" | "right" };
/** @approved A Runner's race stats, shared by Character data, Participant data, the stat sheet and the setup slot it produces. */
export type RaceStats = { style: RunningStyle; speed: number; stamina: number; power: number; guts: number; wit: number };
/** @approved `participantId` links a Cast Runner's gate back to the Cast for Portrait, stat sheet and withdrawal; roster Runners leave it unset. */
export type RaceRunner = { name: string; participantId?: number } & RaceStats;
export type RaceSetup = {
	raceId: string; course: RaceCourse; metresPerStretch: number; slots: RaceRunner[];
	auto: "off" | "on" | { until: number }; phase: "setup" | "running";
};
export type RaceStanding = { name: string; distance: number; energy: number; time: number };
export type RaceMoveKind = "overtake" | "conserve" | "spurt" | "hold";
/** @approved A Race Move acts on one Runner: the human-seat Runner, or the Runner the writer orders when the human seat is not racing. */
export type RaceMove = { kind: RaceMoveKind; runner: string };
/** @approved A Hidden intent is formed in one Stretch and pays off in a later one; the Results Stretch settles any still open, so a finished race has none open. */
export type RaceIntent = { runner: string; formed: number; payoff: number | null };
export type RaceDecision = { kind: RaceMoveKind; writer: boolean; success: boolean };
export type RaceReplayStretch = { stretch: number; metres: number; runners: { name: string; energy: number; decisions: RaceDecision[] }[] };
export type RaceSpectatorState = { raceId: string; stretch: number; metres: number; finished: boolean; standings: RaceStanding[] };
// @approved
//  A record is the race after its turn: standings and Hidden intents, and the
// replay entry the turn added, if any. A Stretch adds one; a withdrawal, a
// walkover and the Results Stretch add none. The fold appends the entries,
// so no record repeats an earlier Stretch.
export type RaceRecord = RaceSpectatorState & { intents: RaceIntent[]; entries: RaceReplayStretch[] };
export type RaceState = RaceSpectatorState & { intents: RaceIntent[]; replay: RaceReplayStretch[] };
// @approved
//  Where a race stands: not started, a Stretch due, the field over the line
//  with the Results Stretch due, or finished, a walkover included. `auto`
//  says whether Auto mode advances it on a continue turn, which also turns
//  the writer's Moves off.
export type RacePhase<State = RaceSpectatorState> =
	| { readonly kind: "setup" }
	| { readonly kind: "running" | "crossed"; readonly state: State; readonly auto: boolean }
	| { readonly kind: "finished"; readonly state: State };
export type RaceInput = { setup: RaceSetup; state: RaceState | null; seed: string; intent: "respond" | "continue"; withdrawn?: readonly string[]; moves: readonly RaceMove[] };
export type RacePortrait = { hash: string; focalX: number; focalY: number };
export type RaceCastMember = { id: number; name: string; portrait: RacePortrait | null; character: { id: number; name: string | null } | null };

// @approved
//  What the window shows: the setup, the race as a spectator sees it, the
// replay and Hidden intents only once it finished, the Cast with Portraits,
// the human seat, roster avatars and every revision a commit needs.
export type RaceView = {
	setup: RaceSetup;
	phase: RacePhase;
	replay: { stretches: RaceReplayStretch[]; intents: RaceIntent[] } | null;
	cast: RaceCastMember[];
	human: number | null;
	avatars: Record<string, { hash: string; revision: number }>;
	castStats: { participantId: number; stats: RaceStats }[];
	characterStatsRevisions: Record<string, number>;
};

export const ordinal = (rank: number) => `${rank}${rank === 1 ? "st" : rank === 2 ? "nd" : rank === 3 ? "rd" : "th"}`;

/** @approved The dock follows the human seat's Runner when it is racing, else the first gate. */
export const raceStatus = (setup: RaceSetup, phase: RacePhase, follows?: string): string | null => {
	if (phase.kind === "setup") return null;
	const { standings, metres } = phase.state;
	if (phase.kind === "finished") return `🏁 1st · ${standings[0]?.name ?? ""}`;
	const followed = standings.some(({ name }) => name === follows) ? follows : setup.slots[0]?.name;
	const rank = standings.findIndex(({ name }) => name === followed) + 1;
	return `🏇 ${metres}m · ${ordinal(Math.max(rank, 1))}`;
};

export const isRaceAutoValid = (setup: RaceSetup): boolean => setup.auto === "on" || setup.auto === "off" || setup.auto.until < setup.course.distance;

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

export const raceMoveLabel = ({ kind, runner }: RaceMove): string => `${raceMoveCatalog[kind].label} · ${runner}`;

/** @approved Energy after a Move resolves; resolution and projection both cap it to [0, 1]. */
export const spendEnergy = (energy: number, kind: RaceMoveKind): number => Math.min(1, Math.max(0, energy - raceMoveCatalog[kind].cost));

export type RunnerMoveKind = Exclude<RaceMoveKind, "hold">;
export type RaceMoveCheck = { readonly legal: true; readonly cost: number; readonly odds: number } | { readonly legal: false; readonly reason: string };

const clampOdds = (odds: number) => Math.round(Math.min(0.95, Math.max(0.05, odds)) * 100) / 100;
const notRacing = (name: string): RaceMoveCheck => ({ legal: false, reason: `${name} is not racing.` });
const isAttack = (kind: RaceMoveKind) => kind === "overtake" || kind === "spurt";

/** @approved One rule for the window's offer and the Stretch's resolution: `earlier` are the Moves staged or resolved before this one, whose costs it projects. */
export function checkRaceMove(setup: RaceSetup, phase: RacePhase, earlier: readonly RaceMove[], move: RaceMove): RaceMoveCheck {
	if (phase.kind === "setup" || phase.kind === "finished") return { legal: false, reason: "The race is not running." };
	if (phase.kind === "crossed") return { legal: false, reason: "The field has crossed the line." };
	if (phase.auto) return { legal: false, reason: "Moves are off while Auto mode runs." };
	const { state } = phase;
	const runner = setup.slots.find(({ name }) => name === move.runner);
	if (runner === undefined || !state.standings.some(({ name }) => name === move.runner)) return notRacing(move.runner);
	if (earlier.length >= MAX_RACE_MOVES) return { legal: false, reason: `A turn holds at most ${MAX_RACE_MOVES} Moves.` };
	if (earlier.some(({ kind }) => kind === "hold")) return { legal: false, reason: "Hold skips this Stretch." };
	if (move.kind === "hold") return earlier.length === 0 ? { legal: true, cost: 0, odds: 1 } : { legal: false, reason: "Hold must be the only Move." };
	return checkRunnerMove(setup, state, earlier, runner, move.kind);
}

/** @approved The rule for one Runner's attack or easing, shared by the writer's Moves and the engine's own decisions. */
export function checkRunnerMove(setup: RaceSetup, state: RaceSpectatorState, earlier: readonly RaceMove[], runner: RaceRunner, kind: RunnerMoveKind): RaceMoveCheck {
	const { distance } = setup.course;
	const { name } = runner;
	const index = state.standings.findIndex((standing) => standing.name === name);
	const standing = state.standings[index];
	if (standing === undefined) return notRacing(name);
	const own = earlier.filter((move) => move.runner === name);
	if (own.some((move) => isAttack(kind) ? isAttack(move.kind) : move.kind === kind)) {
		return { legal: false, reason: `${name} already ${isAttack(kind) ? "attacks" : "eases off"} this Stretch.` };
	}
	const energy = own.reduce((left, move) => spendEnergy(left, move.kind), standing.energy);
	const { cost } = raceMoveCatalog[kind];
	switch (kind) {
		case "conserve":
			return energy - cost > 1 ? { legal: false, reason: `${name} is already fresh.` } : { legal: true, cost, odds: 1 };
		case "overtake": {
			if (energy - cost < FATIGUE_ENERGY) return { legal: false, reason: `${name} is too tired to attack.` };
			const ahead = state.standings[index - 1];
			if (ahead === undefined) return { legal: false, reason: `${name} already leads.` };
			/** @approved The odds reach their floor near the ground one surge gains, so a Runner far behind cannot pass. */
			const gap = ahead.distance - standing.distance;
			return { legal: true, cost, odds: clampOdds(0.75 - gap / 15 + (runner.power + runner.wit - 1200) / 4000) };
		}
		case "spurt":
			if (energy - cost < FATIGUE_ENERGY) return { legal: false, reason: `${name} is too tired to attack.` };
			return state.metres < distance - 400
				? { legal: false, reason: "A spurt opens in the final 400 m." }
				: { legal: true, cost, odds: clampOdds(0.4 + runner.guts / 2000 + energy / 4) };
	}
}

// @approved
//  Equality of two values as JSON, independent of key order, as setups are
//  compared: a stored setup and a draft may list keys differently. Each
//  object serializes with its keys sorted.
const canonical = <T>(value: T) => JSON.stringify(value, (_key, inner) => inner instanceof Object && !Array.isArray(inner)
	? Object.fromEntries(Object.entries(inner).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : inner);
export const jsonEqual = <T>(left: T, right: T): boolean => canonical(left) === canonical(right);
