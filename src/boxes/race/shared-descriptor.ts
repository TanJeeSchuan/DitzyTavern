import { describeMoves, describeSetup, type BoxDescriptor } from "@/box-sdk/shared";
import { raceMove, raceRecord, raceSetup } from "./contract";
import { initialRaceSetup } from "./shared-data";
import { MAX_RACE_MOVES, raceMoveLabel } from "./shared";

export default {
	id: "race", sdk: 1, label: "Race", role: "system", startsEnabled: false, instructions: "",
	setup: describeSetup(raceSetup, initialRaceSetup),
	record: raceRecord,
	moves: describeMoves(raceMove, MAX_RACE_MOVES, raceMoveLabel),
} satisfies BoxDescriptor;
