import { isDeepStrictEqual } from "node:util";
import { isRaceAutoValid, raceMove, raceRecord, raceSetup, type RaceInput, type RaceMove, type RaceRecord, type RaceSetup, type RaceState } from "../../shared/contract/race";
import { checkRaceMove, raceMoveCatalog, raceMoveLabel } from "../../shared/race-moves";
import { initialRaceSetup } from "../../shared/race-data";
import type { Box } from "./contract";
import { advanceRace, currentRaceState, foldRace, raceStatus } from "./race-engine";

export const raceBox = {
	setup: { schema: raceSetup, initial: initialRaceSetup },
	records: { schema: raceRecord, initial: null, fold: foldRace },
	status: raceStatus,
	moves: { schema: raceMove, render: (move) => `(Race Move: ${raceMoveCatalog[move.kind].intent(move.runner)})` },
	advance: {
		fingerprint: ({ dependencies }) => JSON.stringify(dependencies),
		async run({ setup, state, dependencies, moves }) {
			const before = currentRaceState(setup, state);
			// @approved
			//  A slotted Cast Runner whose Participant left the Cast is withdrawn:
			//  the captured slots, folded standings and Hidden intents drop them,
			//  and the item reports the withdrawal before narrating the Stretch.
			const withdrawn = new Set(dependencies.withdrawn ?? []);
			const withdrawalLines = before.standings.flatMap(({ name }) => withdrawn.has(name) ? [`${name} is withdrawn.`] : []);
			const captured = withdrawalLines.length === 0 ? { setup, state } : {
				setup: { ...setup, slots: setup.slots.filter(({ name }) => !withdrawn.has(name)) },
				state: {
					...before,
					standings: before.standings.filter(({ name }) => !withdrawn.has(name)),
					intents: before.intents.filter(({ runner }) => !withdrawn.has(runner)),
				},
			};
			const withWithdrawals = (text: string) => {
				if (withdrawalLines.length === 0) return text;
				const [heading, ...rest] = text.split("\n");
				return [heading, ...withdrawalLines, ...rest].join("\n");
			};
			const [first] = moves;
			// @approved
			//  A withdrawal is captured once and persisted even when no Stretch
			//  advances, so it is announced exactly once instead of on every Hold.
			const withdrawalRecord = (text: string): RaceRecord => ({
				raceId: setup.raceId, stretch: before.stretch, outcome: text,
				after: {
					...before,
					standings: before.standings.filter(({ name }) => !withdrawn.has(name)),
					intents: before.intents.filter(({ runner }) => !withdrawn.has(runner)),
				},
			});
			const holds = dependencies.intent === "respond" && captured.setup.slots.length >= 2 && moves.length === 1 && first?.kind === "hold"
				&& checkRaceMove(captured.setup, currentRaceState(captured.setup, captured.state), [], first).legal;
			if (holds) {
				const text = withWithdrawals(`${setup.course.name}\n${raceMoveLabel(first)}: ${raceMoveCatalog.hold.effect()} Do not narrate race progress past ${before.metres} m.`);
				return withdrawalLines.length === 0
					? { items: [{ text, priority: 100, pinned: true }] }
					: { items: [{ text, priority: 100, pinned: true }], record: withdrawalRecord(text) };
			}
			const record = advanceRace({ ...captured, moves, ...dependencies });
			// @approved
			//  A field reduced below two Runners cannot run another Stretch: the
			//  withdrawal still becomes a record, and the remaining Runner wins by
			//  default.
			if (record === undefined && withdrawalLines.length > 0 && setup.phase === "running" && !before.finished) {
				if (captured.setup.slots.length < 2) {
					const standings = before.standings.filter(({ name }) => !withdrawn.has(name));
					const result = standings.length === 0 ? ["The race is called off."] : [`${standings[0]!.name} wins by default.`];
					const outcome = [setup.course.name, ...withdrawalLines, ...result, "Narrate the finish."].join("\n");
					const stretch = before.stretch + 1;
					const intents = before.intents.filter(({ runner }) => !withdrawn.has(runner))
						.map((planned) => planned.payoff === null ? { ...planned, payoff: stretch } : planned);
					return {
						items: [{ text: outcome, priority: 100, pinned: true }],
						// @approved
						//  The walkover settles every surviving Runner's open Hidden
						//  intent, exactly as the Results Stretch does.
						record: { raceId: setup.raceId, stretch, outcome, after: { ...before, stretch, finished: true, standings, intents } },
					};
				}
				const text = withWithdrawals(`${setup.course.name}\nThe Stretch does not advance this turn.`);
				return { items: [{ text, priority: 100, pinned: true }], record: withdrawalRecord(text) };
			}
			return { items: record === undefined ? [] : [{ text: withWithdrawals(record.outcome), priority: 100, pinned: true }], record };
		},
	},
} satisfies Box<RaceSetup, Pick<RaceInput, "seed" | "intent" | "withdrawn">, never, never, RaceRecord, RaceState | null, RaceMove>;

export const raceSetupError = (setup: RaceSetup, previous: RaceSetup): string | undefined => {
	if (previous.phase !== "setup" && setup.raceId === previous.raceId && !isDeepStrictEqual({ ...setup, auto: previous.auto }, previous)) {
		return "Start a new race to change the course or field.";
	}
	if (!isRaceAutoValid(setup)) return "Auto must stop within the course distance.";
	if (new Set(setup.slots.map(({ name }) => name.trim().toLowerCase())).size !== setup.slots.length) return "Each Runner can occupy only one gate.";
	if (setup.phase !== "setup" && (setup.slots.length < 2 || setup.raceId === "")) return "A race needs an id and at least two Runners.";
	return undefined;
};
