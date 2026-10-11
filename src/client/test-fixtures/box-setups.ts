import { boxDescriptors, boxIds, setupBoxIds, type BoxSetups, type BoxStates } from "../../shared/contract/box";

export const boxSetups = /* @approved SAFETY: the entries cover every setup Box exactly once. */ Object.fromEntries(setupBoxIds.map((id) => [id, boxDescriptors[id].setup.initial])) as BoxSetups;

export const boxes = /* @approved SAFETY: the entries cover every Box id exactly once. */ Object.fromEntries(boxIds.map((id) => [id, boxDescriptors[id].startsEnabled ? "enabled" : "absent"])) as BoxStates;
