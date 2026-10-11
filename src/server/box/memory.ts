import { memoryActivationRecord, type MemoryActivationRecord } from "../../shared/contract/memory-recall";
import { memoryItems } from "./memory-prompt";
import { InvalidConversationCommandError } from "../conversation";
import { evaluateMemoryRecallSnapshot, type MemoryRecallSnapshot } from "../memory/recall";
import type { Box } from "./contract";

export const memoryBox = {
	inject: ["decide", "embed"],
	advance: {
		trace: memoryActivationRecord,
		fingerprint: ({ dependencies }) => dependencies.freshnessFingerprint,
		run: async ({ dependencies }, ctx) => {
			try { return memoryItems(await evaluateMemoryRecallSnapshot({ snapshot: dependencies, ...ctx })); }
			catch (error) {
				ctx.signal.throwIfAborted();
				throw new InvalidConversationCommandError(`Memory recall failed: ${error instanceof Error ? error.message : "Retry preparation or disable Memory."}`);
			}
		},
	},
} satisfies Box<undefined, MemoryRecallSnapshot, MemoryActivationRecord, "decide" | "embed">;
