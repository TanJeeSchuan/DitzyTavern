import { initialRaceSetup } from "../../shared/race-data";
import { boxDescriptors, boxIds, type BoxSetups, type BoxStates } from "../../shared/contract/box";

export const boxSetups: BoxSetups = {
	"author-note": "",
	race: initialRaceSetup,
	"world-clock": { start: "2025-06-01T08:00", era: "AD", climate: "temperate", hemisphere: "north", unit: "C" },
};

export const boxes = /* @approved SAFETY: the entries cover every Box id exactly once. */ Object.fromEntries(boxIds.map((id) => [id, boxDescriptors[id].startsEnabled ? "enabled" : "absent"])) as BoxStates;
