import { describeMoves, type BoxDescriptor } from "@/box-sdk/shared";
import { MAX_PHONE_MOVES, phoneMove } from "./contract";
import { phoneInstructions, phoneMoveLabel } from "./shared";

export default {
	id: "phone", sdk: 1, label: "Phone", role: "system", startsEnabled: false, instructions: phoneInstructions,
	moves: { ...describeMoves(phoneMove, MAX_PHONE_MOVES, phoneMoveLabel), seatBound: true },
} satisfies BoxDescriptor;
