import type { MoveStaging } from "@/box-sdk/client";

export const dropCoin = (staging: MoveStaging) => staging.onChange({ ...staging.moves, "tip-jar": [{ coins: 1 }] });
