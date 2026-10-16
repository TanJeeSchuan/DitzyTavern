import { boxDescriptors, boxesWith, type BoxSetups, type BoxStates } from "../../shared/contract/box";

export const boxSetups: BoxSetups = Object.fromEntries(boxesWith("setup").map(([id, { initial }]) => [id, initial]));

export const boxes: BoxStates = Object.fromEntries([...boxDescriptors()].map(([id, { startsEnabled }]) => [id, startsEnabled ? "enabled" : "absent"]));
