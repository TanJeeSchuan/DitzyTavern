import { isDeepStrictEqual } from "node:util";
import { isRaceAutoValid, type RaceInput, type RaceMove, type RaceRead, type RaceRecord, type RaceSetup, type RaceState } from "./contract";
import { readCharacterRevisions, readLibraryValues, type Box, type BoxWindowRead } from "@/box-sdk/server";
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

function readRace({ db, conversationId, summary, setup, state: folded }: BoxWindowRead<RaceSetup, RaceState | null>): RaceRead {
	const { intents, replay, ...state } = folded ?? initialRaceState(setup);
	const humanRunner = setup.slots.find(({ participantId }) => participantId !== undefined && participantId === summary.control.humanParticipantId)?.name;
	return {
		conversationId, revision: summary.revision, status: raceStatus(setup, state, humanRunner), state,
		replay: state.finished ? { stretches: replay, intents } : null,
		castStats: readRaceCastStats(db, summary.cast.map(({ id }) => id)),
		avatars: Object.fromEntries(readLibraryValues(db, "race", RACE_AVATAR_PREFIX).map(({ key, value, revision }) => [key.slice(RACE_AVATAR_PREFIX.length), { hash: value, revision }])),
		characterStatsRevisions: Object.fromEntries(readCharacterRevisions(db, "race", "stats", summary.cast.flatMap(({ sourceCharacterId }) => sourceCharacterId ?? []))
			.map(({ characterId, revision }) => [characterId, revision])),
	};
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
