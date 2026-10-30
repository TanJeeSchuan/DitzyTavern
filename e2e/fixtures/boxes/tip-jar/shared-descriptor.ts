import { describeMoves, type BoxDescriptor } from "@/box-sdk/shared";
import { tipMove, tipRecord } from "./shared";

export default {
	id: "tip-jar", sdk: 2, label: "Tip Jar", summary: "Collects the coins the writer drops, one per Move.", role: "system", startsEnabled: false, instructions: "",
	record: tipRecord,
	moves: describeMoves(tipMove, 1, ({ coins }) => `Tip ${coins}`),
} satisfies BoxDescriptor;
