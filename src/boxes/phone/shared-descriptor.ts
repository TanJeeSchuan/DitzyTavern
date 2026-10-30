import { describeMoves, type BoxDescriptor } from "@/box-sdk/shared";
import { MAX_PHONE_MOVES, phoneMove } from "./contract";
import { phoneInstructions, phoneMoveLabel } from "./shared";

export default {
	id: "phone", sdk: 2, label: "Phone", summary: "Shows the Cast's text messages in one thread per contact.", role: "system", startsEnabled: false, instructions: phoneInstructions,
	moves: { ...describeMoves(phoneMove, MAX_PHONE_MOVES, phoneMoveLabel), seatBound: true },
} satisfies BoxDescriptor;
