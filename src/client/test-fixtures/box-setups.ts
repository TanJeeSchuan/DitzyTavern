import { boxDescriptors, type BoxSetups, type BoxStates } from "../../shared/contract/box";

export const boxSetups: BoxSetups = Object.fromEntries([...boxDescriptors()].flatMap(([id, { setup }]) => setup === undefined ? [] : [[id, setup.initial]]));

export const boxes: BoxStates = Object.fromEntries([...boxDescriptors()].map(([id, { startsEnabled }]) => [id, startsEnabled ? "enabled" : "absent"]));
