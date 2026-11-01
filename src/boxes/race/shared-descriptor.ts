import { describeMoves, describeSetup, type BoxDescriptor } from "@/box-sdk/shared";
import { raceMove, raceSetup, raceState, raceStats } from "./contract";
import { initialRaceSetup } from "./shared-data";
import { MAX_RACE_MOVES, raceMoveLabel } from "./shared";

export default {
	id: "race", sdk: 2, label: "Race", summary: "Runs a horse race whose Moves and Stretches the writer plays out.", role: "system", startsEnabled: false, instructions: "",
	setup: describeSetup(raceSetup, initialRaceSetup),
	record: raceState,
	values: { participant: { stats: raceStats } },
	moves: describeMoves(raceMove, MAX_RACE_MOVES, raceMoveLabel),
} satisfies BoxDescriptor;
