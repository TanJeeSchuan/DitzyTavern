import { initialRaceSetup } from "../../shared/race-data";
import type { BoxSetups, BoxStates } from "../../shared/contract/box";

export const boxSetups: BoxSetups = {
	"author-note": "",
	race: initialRaceSetup,
	"world-clock": { start: "2025-06-01T08:00", era: "AD", climate: "temperate", hemisphere: "north", unit: "C" },
};

export const boxes: BoxStates = { "author-note": "enabled", memory: "enabled", "world-clock": "absent", race: "absent", phone: "absent" };
