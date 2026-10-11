import { isDeepStrictEqual } from "node:util";
import { isRaceAutoValid, raceRecord, raceSetup, type RaceInput, type RaceRecord, type RaceSetup, type RaceState } from "../../shared/contract/race";
import { initialRaceSetup } from "../../shared/race-data";
import type { Box } from "./contract";
import { advanceRace, foldRace, raceStatus } from "./race-engine";

export const raceBox = {
	setup: { schema: raceSetup, initial: initialRaceSetup },
	records: { schema: raceRecord, initial: null, fold: foldRace },
	status: raceStatus,
	advance: {
		fingerprint: ({ dependencies }) => JSON.stringify(dependencies),
		async run({ setup, state, dependencies }) {
			const record = advanceRace({ setup, state, ...dependencies });
			return { items: record === undefined ? [] : [{ text: record.outcome, priority: 100, pinned: true }], record };
		},
	},
} satisfies Box<RaceSetup, Pick<RaceInput, "seed" | "intent">, never, never, RaceRecord, RaceState | null>;

export const raceSetupError = (setup: RaceSetup, previous: RaceSetup): string | undefined => {
	if (previous.phase !== "setup" && setup.raceId === previous.raceId && !isDeepStrictEqual({ ...setup, auto: previous.auto }, previous)) {
		return "Start a new race to change the course or field.";
	}
	if (!isRaceAutoValid(setup)) return "Auto must stop within the course distance.";
	if (new Set(setup.slots.map(({ name }) => name.trim().toLowerCase())).size !== setup.slots.length) return "Each Runner can occupy only one gate.";
	if (setup.phase !== "setup" && (setup.slots.length < 2 || setup.raceId === "")) return "A race needs an id and at least two Runners.";
	return undefined;
};
