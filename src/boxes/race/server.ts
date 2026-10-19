import { isDeepStrictEqual } from "node:util";
import { isRaceAutoValid, raceRecord, raceSetup, type RaceInput, type RaceMove, type RaceRead, type RaceRecord, type RaceSetup, type RaceState } from "./contract";
import type { Database } from "bun:sqlite";
import { and, eq, inArray, like } from "drizzle-orm";
import {
	boxReference, characterDataTable, foldRecords, libraryDataTable, readBoxLifecycles, readConversationSummaryFromConnection, readRecordSlots, readSelectedHistoryFromConnection,
	runConversationReadTransaction, type Box,
} from "@/box-sdk/server";
import { boxSetupOf } from "@/box-sdk/shared";
import { RACE_AVATAR_PREFIX } from "./shared-data";
import { readRaceCastStats } from "./server-cast";
import { raceMoveCatalog } from "./shared";
import { advanceRace, foldRace, initialRaceState, raceStatus } from "./server-engine";

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
			const turn = advanceRace({ setup, state, moves, ...dependencies });
			return { items: turn === undefined ? [] : [{ text: turn.narrative, priority: 100, pinned: true }], record: turn?.record };
		},
	},
} satisfies Box<RaceSetup, Pick<RaceInput, "seed" | "intent" | "withdrawn">, never, RaceRecord, RaceState | null, RaceMove>;
export default raceBox;

function readRace(database: Database, conversationId: number): RaceRead | undefined {
	return runConversationReadTransaction(database, (db) => {
		const summary = readConversationSummaryFromConnection(db, conversationId);
		if (summary === undefined) return undefined;
		const history = readSelectedHistoryFromConnection(db, conversationId, { conversationData: false });
		if (history === undefined) return undefined;
		const setup = boxSetupOf(summary, "race", raceSetup);
		const ids = history.messages.flatMap(({ variant }) => variant === null ? [] : [variant.id]);
		const { intents, replay, ...state } = foldRecords(raceBox.records, setup, readRecordSlots(db, "race", raceRecord, readBoxLifecycles(db, conversationId).race?.instance, ids), ids) ?? initialRaceState(setup);
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
