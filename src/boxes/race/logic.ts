import { advanceRace, foldRace, racePhase } from "./logic-engine";
import { RACE_AVATAR_PREFIX } from "./shared-data";
import {
	isRaceAutoValid, jsonEqual, raceMoveCatalog, raceStatus,
	type RaceCastMember, type RaceInput, type RaceMove, type RaceSetup, type RaceSpectatorState, type RaceState, type RaceStats, type RaceView,
} from "./shared";

type Dependencies = Pick<RaceInput, "seed" | "intent" | "withdrawn">;
/** @approved What the host hands `read`: the setup and folded state, this Chat's Cast and its human seat, and `snapshot` for the Race's own stored values. */
type ReadInput = { setup: RaceSetup; state: RaceState | null; cast: RaceCastMember[]; human: number | null };
/** @approved The host's `snapshot`, with the rows each query it answers documents. */
type Snapshot = {
	snapshot(query: { scope: "participant"; key: string }): { participantId: number; value: string }[];
	snapshot(query: { scope: "library"; prefix: string }): { key: string; value: string; revision: number }[];
	snapshot(query: { scope: "character"; key: string }): { characterId: number; revision: number }[];
};

/** @approved The replay and Hidden intents stay in the logic until the finish. */
const spectatorOf = ({ intents: _intents, replay: _replay, ...state }: RaceState): RaceSpectatorState => state;

export default {
	setupError: raceSetupError,
	// @approved
	//  `withdrawn` lists slotted Cast Runners whose Participant has left the
	//  Cast; only the host reads the Cast.
	dependencies: ({ seed, intent, cast }: { seed: string; intent: RaceInput["intent"]; cast: { id: number }[] }, setup: RaceSetup): Dependencies => ({
		seed, intent, withdrawn: setup.slots.flatMap(({ name, participantId }) => participantId !== undefined && !cast.some(({ id }) => id === participantId) ? [name] : []),
	}),
	moves: { render: (move: RaceMove) => `(Race Move: ${raceMoveCatalog[move.kind].intent(move.runner)})` },
	records: { initial: null, fold: foldRace },
	advance: {
		async run({ setup, state, dependencies, moves }: { setup: RaceSetup; state: RaceState | null; dependencies: Dependencies; moves: RaceMove[] }) {
			const turn = advanceRace({ setup, state, moves, ...dependencies });
			return { items: turn === undefined ? [] : [{ text: turn.narrative, priority: 100, pinned: true }], record: turn?.record };
		},
	},
	read: readRace,
};

function readRace({ setup, state, cast, human }: ReadInput, { snapshot }: Snapshot) {
	const phase = racePhase(setup, state);
	const humanRunner = setup.slots.find(({ participantId }) => participantId !== undefined && participantId === human)?.name;
	const stats = snapshot({ scope: "participant", key: "stats" });
	const avatars = snapshot({ scope: "library", prefix: RACE_AVATAR_PREFIX });
	const revisions = snapshot({ scope: "character", key: "stats" });
	return {
		status: raceStatus(setup, phase, humanRunner) ?? "Set up a race",
		view: {
			setup, cast, human,
			phase: phase.kind === "setup" ? phase : { ...phase, state: spectatorOf(phase.state) },
			replay: phase.kind === "finished" ? { stretches: phase.state.replay, intents: phase.state.intents } : null,
			/** @approved SAFETY: the host checks every stored stats value against the descriptor's Participant schema. */
			castStats: stats.map(({ participantId, value }) => ({ participantId, stats: JSON.parse(value) as RaceStats })),
			avatars: Object.fromEntries(avatars.map(({ key, value, revision }) => [key.slice(RACE_AVATAR_PREFIX.length), { hash: value, revision }])),
			characterStatsRevisions: Object.fromEntries(revisions.map(({ characterId, revision }) => [characterId, revision])),
		},
	} satisfies { status: string; view: RaceView };
}

function raceSetupError(setup: RaceSetup, previous: RaceSetup): string | undefined {
	if (previous.phase !== "setup" && setup.raceId === previous.raceId && !jsonEqual({ ...setup, auto: previous.auto }, previous)) {
		return "Start a new race to change the course or field.";
	}
	if (!isRaceAutoValid(setup)) return "Auto must stop within the course distance.";
	if (new Set(setup.slots.map(({ name }) => name.trim().toLowerCase())).size !== setup.slots.length) return "Each Runner can occupy only one gate.";
	if (setup.phase !== "setup" && (setup.slots.length < 2 || setup.raceId === "")) return "A race needs an id and at least two Runners.";
	return undefined;
}
