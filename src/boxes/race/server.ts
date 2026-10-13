import { isDeepStrictEqual } from "node:util";
import { isRaceAutoValid, raceRecord, raceSetup, type RaceInput, type RaceMove, type RaceRead, type RaceRecord, type RaceSetup, type RaceState } from "./contract";
import type { Database } from "bun:sqlite";
import { and, eq, inArray, like } from "drizzle-orm";
import {
	boxReference, characterDataTable, foldRecords, libraryDataTable, readBoxInstances, readConversationSummaryFromConnection, readRecordSlots, readSelectedHistoryFromConnection,
	runConversationReadTransaction, type Box,
} from "@/box-sdk/server";
import { boxSetupOf } from "@/box-sdk/shared";
import { RACE_AVATAR_PREFIX } from "./shared-data";
import { readRaceCastStats } from "./server-cast";
import { checkRaceMove, raceMoveCatalog, raceMoveLabel } from "./shared";
import { advanceRace, currentRaceState, foldRace, initialRaceState, raceStatus } from "./server-engine";

const raceBox = {
	setupError: raceSetupError,
	records: { initial: null, fold: foldRace },
	moves: { render: (move) => `(Race Move: ${raceMoveCatalog[move.kind].intent(move.runner)})` },
	// @approved
	//  `withdrawn` lists slotted Cast Runners whose Participant has left the
	//  Cast; only the host reads the Cast.
	dependencies: ({ seed, intent, cast }, setup) => ({
		seed, intent, withdrawn: setup.slots.flatMap(({ name, participantId }) => participantId !== undefined && !cast.some(({ id }) => id === participantId) ? [name] : []),
	}),
	read: readRace,
	advance: {
		async run({ setup, state, dependencies, moves }) {
			const before = currentRaceState(setup, state);
			// @approved
			//  A slotted Cast Runner whose Participant left the Cast is withdrawn:
			//  the captured slots, folded standings and Hidden intents drop them,
			//  and the item reports the withdrawal before narrating the Stretch.
			const withdrawn = new Set(dependencies.withdrawn ?? []);
			const withdrawalLines = before.standings.flatMap(({ name }) => withdrawn.has(name) ? [`${name} is withdrawn.`] : []);
			const remaining = {
				...before,
				standings: before.standings.filter(({ name }) => !withdrawn.has(name)),
				intents: before.intents.filter(({ runner }) => !withdrawn.has(runner)),
			};
			// @approved
			//  A withdrawal saved on an earlier Hold leaves the folded state clean
			//  but the setup still slots the Runner, so the slots are always filtered.
			const captured = {
				setup: { ...setup, slots: setup.slots.filter(({ name }) => !withdrawn.has(name)) },
				state: withdrawalLines.length === 0 ? state : remaining,
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
			const withdrawalRecord = (text: string): RaceRecord => ({ raceId: setup.raceId, stretch: before.stretch, outcome: text, after: remaining });
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
					const { standings } = remaining;
					const result = standings.length === 0 ? ["The race is called off."] : [`${standings[0]!.name} wins by default.`];
					const outcome = [setup.course.name, ...withdrawalLines, ...result, "Narrate the finish."].join("\n");
					const stretch = before.stretch + 1;
					const intents = remaining.intents.map((planned) => planned.payoff === null ? { ...planned, payoff: stretch } : planned);
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
export default raceBox;

function readRace(database: Database, conversationId: number): RaceRead | undefined {
	return runConversationReadTransaction(database, (db) => {
		const summary = readConversationSummaryFromConnection(db, conversationId);
		if (summary === undefined) return undefined;
		const history = readSelectedHistoryFromConnection(db, conversationId, { conversationData: false });
		if (history === undefined) return undefined;
		const setup = boxSetupOf(summary, "race", raceSetup);
		const ids = history.messages.flatMap(({ variant }) => variant === null ? [] : [variant.id]);
		const { intents, replay, ...state } = foldRecords(raceBox.records, setup, readRecordSlots(db, "race", raceRecord, readBoxInstances(db, conversationId).race, ids), ids) ?? initialRaceState(setup);
		const humanRunner = setup.slots.find(({ participantId }) => participantId !== undefined && participantId === summary.control.humanParticipantId)?.name;
		return {
			conversationId, revision: summary.revision, status: raceStatus(setup, state, humanRunner), state,
			replay: state.finished ? { stretches: replay, intents } : null,
			castStats: readRaceCastStats(db, summary.cast.map(({ id }) => id)),
			avatars: Object.fromEntries(db.select({ key: libraryDataTable.key, value: libraryDataTable.value, revision: libraryDataTable.revision }).from(libraryDataTable)
				.where(and(eq(libraryDataTable.namespace, boxReference("race")), like(libraryDataTable.key, `${RACE_AVATAR_PREFIX}%`))).all()
				.map(({ key, value, revision }) => [key.slice(RACE_AVATAR_PREFIX.length), { hash: value, revision }])),
			characterStatsRevisions: Object.fromEntries(db.select({ id: characterDataTable.character_id, revision: characterDataTable.revision }).from(characterDataTable)
				.where(and(eq(characterDataTable.namespace, boxReference("race")), eq(characterDataTable.key, "stats"),
					inArray(characterDataTable.character_id, summary.cast.flatMap(({ sourceCharacterId }) => sourceCharacterId ?? [])))).all()
				.map(({ id, revision }) => [id, revision])),
		};
	});
}

function raceSetupError(setup: RaceSetup, previous: RaceSetup): string | undefined {
	if (previous.phase !== "setup" && setup.raceId === previous.raceId && !isDeepStrictEqual({ ...setup, auto: previous.auto }, previous)) {
		return "Start a new race to change the course or field.";
	}
	if (!isRaceAutoValid(setup)) return "Auto must stop within the course distance.";
	if (new Set(setup.slots.map(({ name }) => name.trim().toLowerCase())).size !== setup.slots.length) return "Each Runner can occupy only one gate.";
	if (setup.phase !== "setup" && (setup.slots.length < 2 || setup.raceId === "")) return "A race needs an id and at least two Runners.";
	return undefined;
}
