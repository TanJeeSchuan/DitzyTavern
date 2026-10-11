import { initialRaceSetup } from "../../shared/race-data";
import type { BoxSetups } from "../../shared/contract/box";

export const boxSetups: BoxSetups = {
	"author-note": "",
	race: initialRaceSetup,
	"world-clock": { enabled: false, start: "2025-06-01T08:00", era: "AD", climate: "temperate", hemisphere: "north", unit: "C" },
};
