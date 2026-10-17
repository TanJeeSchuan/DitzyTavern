import { describeMoves, type BoxDescriptor } from "@/box-sdk/shared";
import { tipMove, tipRecord } from "./shared";

export default {
	id: "tip-jar", sdk: 1, label: "Tip Jar", role: "system", startsEnabled: false, instructions: "",
	record: tipRecord,
	moves: describeMoves(tipMove, 1, ({ coins }) => `${coins}`),
} satisfies BoxDescriptor;
