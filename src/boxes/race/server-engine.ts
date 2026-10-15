import { isNonEmpty } from "@/box-sdk/shared";
import type { RaceDecision, RaceInput, RaceIntent, RaceMove, RaceRecord, RaceRunner, RaceSetup, RaceSpectatorState, RaceStanding, RaceState, RunningStyle } from "./contract";
import { raceRandom } from "./shared-data";
import { checkRaceMove, checkRunnerMove, FATIGUE_ENERGY, MOVE_METRES, raceMoveCatalog, raceMoveLabel, spendEnergy, type RaceMoveCheck, type RunnerMoveKind } from "./shared";

export const initialRaceState = (setup: RaceSetup): RaceState => ({
	raceId: setup.raceId, stretch: 0, metres: 0, finished: false,
	standings: setup.slots.map(({ name }) => ({ name, distance: 0, energy: 1, time: 0 })),
	intents: [], replay: [],
});

/** @approved A record holds the whole state after its Stretch; records of another race leave the current one untouched. */
export const foldRace = (state: RaceState | null, record: RaceRecord, { raceId }: Pick<RaceSetup, "raceId">): RaceState | null => record.raceId === raceId ? record.after : state;

const stylePace = {
	"Front Runner": [1.08, 1.03, 0.99, 0.97],
	"Pace Chaser": [1.03, 1.02, 1.03, 1.01],
	"Late Surger": [0.97, 1, 1.07, 1.08],
	"End Closer": [0.94, 0.98, 1.04, 1.15],
} satisfies Record<RunningStyle, readonly [number, number, number, number]>;
const phaseAt = (metres: number, distance: number): 0 | 1 | 2 | 3 =>
	metres >= distance - 400 ? 3 : metres >= distance * 0.7 ? 2 : metres >= distance / 6 ? 1 : 0;
const phases = ["opening", "middle", "final corner", "last spurt"] satisfies [string, string, string, string];
/** @approved The chance an engine-driven Runner tries to overtake, by Running style and phase before the final 400 m. */
const aggression = {
	"Front Runner": [0.1, 0.15, 0.3],
	"Pace Chaser": [0, 0.25, 0.4],
	"Late Surger": [0, 0.15, 0.45],
	"End Closer": [0, 0.1, 0.4],
} satisfies Record<RunningStyle, readonly [number, number, number]>;
const MAX_INTENTS = 2;
// @approved
//  The one Hidden intent: a closer hangs back on purpose to save energy for
//  a charge in the final 400 m. It pays off in the Stretch the charge
//  succeeds, else in the Results Stretch. The hints describe only what a
//  spectator sees, varied by Runner and Stretch so the narrator does not
//  repeat one beat.
const hiddenIntent = {
	foreshadow: (name: string, rank: string, turn: number) => `Foreshadow, do not reveal: ${[
		`${name} runs ${rank} with an unusually relaxed rhythm.`,
		`${name} runs ${rank} and looks calm, even comfortable.`,
		`${name} runs ${rank}, keeping an easy rhythm and showing no sign of worry.`,
	][turn % 3]} Show this; do not explain why or predict a later move.`,
	reveal: (name: string) => `Reveal now: ${name} had planned all along to save energy for this charge. Keep to the standings above; do not invent a comeback they do not show.`,
	unspent: (name: string) => `Reveal now: ${name} had planned all along to save energy for a late charge, but the charge never came off.`,
};
const ordinal = (rank: number) => `${rank}${rank === 1 ? "st" : rank === 2 ? "nd" : rank === 3 ? "rd" : "th"}`;

// @approved The dock follows the human seat's Runner when it is racing, else the first gate.
export const raceStatus = (setup: RaceSetup, state: RaceSpectatorState | null, follows?: string): string | null => {
	if (setup.phase === "setup") return null;
	const current = state?.raceId === setup.raceId ? state : initialRaceState(setup);
	if (current.finished) return `🏁 1st · ${current.standings[0]?.name ?? ""}`;
	const followed = current.standings.some(({ name }) => name === follows) ? follows : setup.slots[0]?.name;
	const rank = current.standings.findIndex(({ name }) => name === followed) + 1;
	return `🏇 ${current.metres}m · ${ordinal(Math.max(rank, 1))}`;
};

export const currentRaceState = (setup: RaceSetup, state: RaceState | null): RaceState => state?.raceId === setup.raceId ? state : initialRaceState(setup);

type RaceEntrant = { slot: RaceRunner; standing: RaceStanding; position: RaceStanding };
// @approved
//  Pairs each folded standing with its gate once, so the engine never looks
//  a Runner up by name; `position` is the copy the Stretch moves. Withdrawals
//  only drop standings, so a standing without a gate means the raceId was
//  reused for another field: its records are refused instead of resumed.
const raceField = (setup: RaceSetup, state: RaceState): RaceEntrant[] => state.standings.map((standing) => {
	const slot = setup.slots.find(({ name }) => name === standing.name);
	if (slot === undefined) throw new Error(`Race ${setup.raceId} has a record for ${standing.name}, who holds no gate in this setup. Start a new race.`);
	return { slot, standing, position: { ...standing } };
});

const formIntents = (setup: RaceSetup, stretch: number, random: () => number): RaceIntent[] => setup.slots
	.filter(({ style }) => style === "Late Surger" || style === "End Closer")
	.map((runner) => ({ runner, draw: random() }))
	.filter(({ runner, draw }) => draw < runner.wit / 1500)
	.sort((a, b) => a.draw - b.draw)
	.slice(0, MAX_INTENTS)
	.map(({ runner }) => ({ runner: runner.name, formed: stretch, payoff: null }));

/** @approved What an engine-driven Runner does this Stretch: a planned closer conserves and then charges, the rest attack by Running style and phase. */
const engineDecision = (setup: RaceSetup, before: RaceState, { slot, standing }: RaceEntrant, planned: boolean, random: () => number): RunnerMoveKind | undefined => {
	const check = (kind: RunnerMoveKind) => checkRunnerMove(setup, before, [], slot, kind);
	const phase = phaseAt(before.metres, setup.course.distance);
	if (phase === 3) return check("spurt").legal && (planned || random() < 0.5) ? "spurt" : undefined;
	if (planned || standing.energy < FATIGUE_ENERGY + 0.1) return check("conserve").legal ? "conserve" : undefined;
	const overtake = check("overtake");
	return overtake.legal && overtake.odds >= 0.5 && random() < aggression[slot.style][phase] ? "overtake" : undefined;
};

const settleIntents = (intents: RaceIntent[], stretch: number) => intents.map((planned) => planned.payoff === null ? { ...planned, payoff: stretch } : planned);

export function advanceRace({ setup, state, seed, intent, moves, withdrawn = [] }: RaceInput): { narrative: string; record?: RaceRecord } | undefined {
	const original = currentRaceState(setup, state);
	const removed = new Set(withdrawn);
	const withdrawalLines = original.standings.flatMap(({ name }) => removed.has(name) ? [`${name} is withdrawn.`] : []);
	setup = { ...setup, slots: setup.slots.filter(({ name }) => !removed.has(name)) };
	const before = withdrawalLines.length === 0 ? original : {
		...original, standings: original.standings.filter(({ name }) => !removed.has(name)), intents: original.intents.filter(({ runner }) => !removed.has(runner)),
	};
	const narrate = (heading: string, lines: string[]) => [heading, ...withdrawalLines, ...lines].join("\n");
	const unchanged = (narrative: string) => withdrawalLines.length === 0 ? { narrative }
		: { narrative, record: { raceId: setup.raceId, stretch: before.stretch, outcome: narrative, after: before } };
	const [first] = moves;
	if (intent === "respond" && setup.slots.length >= 2 && moves.length === 1 && first?.kind === "hold" && checkRaceMove(setup, before, [], first).legal) {
		return unchanged(narrate(setup.course.name, [`${raceMoveLabel(first)}: ${raceMoveCatalog.hold.effect()} Do not narrate race progress past ${before.metres} m.`]));
	}
	if (setup.phase !== "running" || before.finished) return undefined;
	if (withdrawalLines.length > 0 && setup.slots.length < 2) {
		const stretch = before.stretch + 1;
		const winner = before.standings[0];
		const outcome = narrate(setup.course.name, [winner === undefined ? "The race is called off." : `${winner.name} wins by default.`, "Narrate the finish."]);
		return { narrative: outcome, record: { raceId: setup.raceId, stretch, outcome, after: { ...before, stretch, finished: true, intents: settleIntents(before.intents, stretch) } } };
	}
	const stopped = setup.slots.length < 2 || intent === "continue" && (setup.auto === "off" || (setup.auto !== "on" && setup.auto.until > 0 && before.metres >= setup.course.distance - setup.auto.until));
	const paused = () => withdrawalLines.length === 0 ? undefined : unchanged(narrate(setup.course.name, ["The Stretch does not advance this turn."]));
	if (stopped) return paused();
	const record = advanceStretch({ setup, state: before, seed, intent, moves }, withdrawalLines);
	return record === undefined ? paused() : { narrative: record.outcome, record };
}

function advanceStretch({ setup, state, seed, moves }: RaceInput, withdrawalLines: string[]): RaceRecord | undefined {
	const before = currentRaceState(setup, state);
	const field = raceField(setup, before);
	const stretch = before.stretch + 1;
	const course = `${setup.course.name} · ${setup.course.distance} m · ${setup.course.surface} · ${setup.course.direction}-handed`;
	if (before.metres >= setup.course.distance) {
		// @approved
		//  Standings are in finishing order once the field crosses the line, so
		//  the fastest time is the winner's.
		const winner = Math.min(...before.standings.map(({ time }) => time));
		const order = before.standings.map((runner, index) => `${index + 1}. ${runner.name} — ${index === 0 ? `${runner.time.toFixed(2)} s` : `+${(runner.time - winner).toFixed(2)} s`}`);
		const report = moves.map((move) => `${raceMoveLabel(move)}: fizzles. The race is over.`);
		const outstanding = before.intents.filter(({ payoff }) => payoff === null);
		const reveals = outstanding.map(({ runner }) => hiddenIntent.unspent(runner));
		const outcome = [course, ...withdrawalLines, "Results Stretch", ...order, ...report, ...reveals, "Narrate the finish."].join("\n");
		const intents = settleIntents(before.intents, stretch);
		return { raceId: setup.raceId, stretch, outcome, after: { ...before, stretch, finished: true, intents } };
	}
	if (!isNonEmpty(field)) return undefined;
	const random = raceRandom(seed);
	const finalStart = setup.course.distance - 400;
	const formed = before.stretch === 0 && before.metres < finalStart ? formIntents(setup, stretch, random) : before.intents;
	const pace = new Map<string, number>();
	const resolved: RaceMove[] = [];
	const decisions = new Map<string, RaceDecision[]>();
	const resolve = (move: RaceMove, check: RaceMoveCheck, writer: boolean): string | null => {
		const decide = (success: boolean) => decisions.set(move.runner, [...decisions.get(move.runner) ?? [], { kind: move.kind, writer, success }]);
		if (!check.legal) {
			decide(false);
			return check.reason;
		}
		resolved.push(move);
		const success = random() < check.odds;
		decide(success);
		if (!success) return `${move.runner} ${move.kind === "overtake" ? "is boxed in" : "finds nothing extra"}.`;
		pace.set(move.runner, (pace.get(move.runner) ?? 0) + raceMoveCatalog[move.kind].pace);
		return null;
	};
	const report = moves.map((move) => ({
		move,
		// @approved A Hold that is not alone fizzles and lets the rest resolve; a legal lone Hold has already stopped the turn.
		fizzle: resolve(move, move.kind === "hold" && moves.length > 1 ? { legal: false, reason: "Hold must be the only Move." } : checkRaceMove(setup, before, resolved, move), true),
	}));
	/** @approved Runners the writer gave Moves this turn follow them; every other Runner is driven by the engine. */
	const ordered = new Set(moves.map(({ runner }) => runner));
	const engineReport = field.flatMap((entrant) => {
		const { name } = entrant.slot;
		const kind = ordered.has(name) ? undefined : engineDecision(setup, before, entrant, formed.some((planned) => planned.runner === name && planned.payoff === null), random);
		return kind === undefined ? [] : [{ move: { kind, runner: name }, fizzle: resolve({ kind, runner: name }, checkRunnerMove(setup, before, [], entrant.slot, kind), false) }];
	});
	const charged = (name: string) => (decisions.get(name) ?? []).some(({ kind, success }) => kind === "spurt" && success);
	const intents = formed.map((planned) => planned.payoff === null && charged(planned.runner) ? { ...planned, payoff: stretch } : planned);
	let end = Math.min(setup.course.distance, before.metres + (before.metres >= finalStart ? Math.min(100, setup.metresPerStretch) : setup.metresPerStretch));
	if (before.metres < finalStart) end = Math.min(end, finalStart);
	if (setup.auto !== "off" && setup.auto !== "on" && before.metres < setup.course.distance - setup.auto.until) end = Math.min(end, setup.course.distance - setup.auto.until);
	for (const { slot, position } of field) position.energy = resolved.filter((move) => move.runner === slot.name).reduce((energy, move) => spendEnergy(energy, move.kind), position.energy);
	const stepMetres = (end - before.metres) / 20;
	for (let step = 0; step < 20; step++) {
		const phase = phaseAt(before.metres + step * stepMetres, setup.course.distance);
		const leader = Math.max(...field.map(({ position }) => position.distance));
		const paced = field.map(({ slot: runner, position }) => {
			const fatigue = Math.max(0, FATIGUE_ENERGY - position.energy) * (1 - runner.guts / 1600);
			const chase = Math.min(0.04, (leader - position.distance) / 1000) * runner.wit / 1200;
			const speed = (14 + runner.speed / 180 + runner.power / 900 * (phase >= 2 ? 1 : 0.3))
				* (stylePace[runner.style][phase] + (pace.get(position.name) ?? 0) * Math.min(1, Math.max(0, MOVE_METRES / stepMetres - step)) + chase - fatigue + (random() - 0.5) * (0.12 - runner.wit / 20000));
			return { runner, position, speed };
		});
		const seconds = Math.min(...paced.map(({ position, speed }) => (leader + stepMetres - position.distance) / speed));
		for (const { runner, position, speed } of paced) {
			position.distance += speed * seconds;
			position.time += seconds;
			position.energy = Math.max(0, position.energy - seconds / (100 + runner.stamina / 3) * (phase === 3 ? 1.5 : 1));
			if (end === setup.course.distance && step === 19) position.time += Math.max(0, end - position.distance) / speed;
		}
	}
	const [{ standing: previousLeader }] = field;
	field.sort((a, b) => end === setup.course.distance ? a.position.time - b.position.time : b.position.distance - a.position.distance);
	const [{ position: leader }] = field;
	const standings = field.map(({ position }) => position);
	const cast = new Set(setup.slots.flatMap(({ name, participantId }) => participantId === undefined ? [] : [name]));
	const rankOf = (list: readonly { name: string }[], name: string) => list.findIndex((runner) => runner.name === name) + 1;
	// @approved
	//  Salient events compete on score, doubled for Cast Runners; each Runner
	//  keeps only its best, and the Stretch names two, or three when the third
	//  still matters. Engine Conserves are never events, since they would give
	//  away a Hidden intent.
	const candidates = [
		before.metres === 0 ? { subject: leader.name, score: 2, text: `${leader.name} takes the early lead.` }
			: leader.name === previousLeader.name ? { subject: leader.name, score: 1, text: `${leader.name} holds the lead.` }
			: { subject: leader.name, score: 3, text: `${leader.name} passes ${previousLeader.name} for the lead.` },
		...standings.flatMap(({ name }) => {
			const [from, to] = [rankOf(before.standings, name), rankOf(standings, name)];
			if (before.metres === 0 || Math.abs(from - to) < 2) return [];
			return [{ subject: name, score: Math.abs(from - to), text: `${name} ${to < from ? "climbs" : "drops"} from ${ordinal(from)} to ${ordinal(to)}.` }];
		}),
		...engineReport.flatMap(({ move, fizzle }) => move.kind === "conserve" ? [] : [{
			subject: move.runner, score: fizzle === null ? move.kind === "spurt" ? 2.5 : 1.5 : 1, text: fizzle ?? raceMoveCatalog[move.kind].effect(move.runner),
		}]),
		...field.flatMap(({ slot: { name }, standing, position }) => position.energy < FATIGUE_ENERGY && standing.energy >= FATIGUE_ENERGY
			? [{ subject: name, score: 2, text: `${name} is tiring.` }] : []),
		...standings.slice(-1).map(({ name, distance }) => ({ subject: name, score: 0.5, text: `${name} trails by ${(leader.distance - distance).toFixed(1)} m.` })),
		...standings.slice(1).flatMap(({ name, distance }) => cast.has(name)
			? [{ subject: name, score: 1, text: `${name} runs ${ordinal(rankOf(standings, name))}, ${(leader.distance - distance).toFixed(1)} m off the lead.` }] : []),
	].map((event) => ({ ...event, score: event.score * (cast.has(event.subject) ? 2 : 1) })).sort((a, b) => b.score - a.score)
		.filter((event, index, all) => all.findIndex(({ subject }) => subject === event.subject) === index);
	const events = candidates.slice(0, (candidates[2]?.score ?? 0) >= 2 ? 3 : 2).map(({ text }) => text);
	const order = standings.map((runner, index) => `${index + 1}. ${runner.name} — ${index === 0 ? "leader" : `+${(leader.distance - runner.distance).toFixed(1)} m`}`);
	const moveLines = [
		...report.map(({ move, fizzle }) => `${raceMoveLabel(move)}: ${fizzle !== null ? `fizzles. ${fizzle}` : `succeeds. ${raceMoveCatalog[move.kind].effect(move.runner)}`}`),
		...[...new Set(resolved.map(({ runner }) => runner).filter((runner) => ordered.has(runner)))].map((runner) => {
			const [from, to] = [ordinal(rankOf(before.standings, runner)), ordinal(rankOf(standings, runner))];
			return from === to ? `${runner} holds ${to}.` : `${runner} goes from ${from} to ${to}.`;
		}),
	];
	// @approved
	//  Hints stop at the final 400 m, where the charge is due, and skip a
	//  Runner the writer ordered this turn: the order, not the plan, drove it.
	const hinted = (runner: string) => before.metres < finalStart && !ordered.has(runner);
	const intentLines = intents.flatMap(({ runner, payoff }, index) => payoff === stretch ? [hiddenIntent.reveal(runner)]
		: payoff === null && hinted(runner) ? [hiddenIntent.foreshadow(runner, ordinal(rankOf(standings, runner)), stretch + index)] : []);
	const heading = `Stretch ${stretch}: ${before.metres}–${end} m, ${phases[phaseAt(before.metres, setup.course.distance)]}`;
	const outcome = [course, ...withdrawalLines, heading, ...order, ...events, ...moveLines, ...intentLines, `Narrate only this Stretch. Do not go past ${end} m.`].join("\n");
	const replay = [...before.replay, { stretch, metres: end, runners: standings.map(({ name, energy }) => ({ name, energy, decisions: decisions.get(name) ?? [] })) }];
	return { raceId: setup.raceId, stretch, outcome, after: { raceId: setup.raceId, stretch, metres: end, finished: false, standings, intents, replay } };
}
