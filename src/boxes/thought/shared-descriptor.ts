import type { BoxDescriptor } from "@/box-sdk/shared";
import { thoughtInstructions } from "./shared";

export default { id: "thought", sdk: 1, label: "Thoughts", summary: "Collects the unspoken thoughts characters have in the prose.", role: "system", startsEnabled: false, instructions: thoughtInstructions, alwaysRender: true } satisfies BoxDescriptor;
