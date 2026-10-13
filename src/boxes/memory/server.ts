import { InvalidConversationCommandError, memoryActivationRecord, type Box, type MemoryActivationRecord, type MemoryRecall } from "../../box-sdk/server";
import { memoryItems } from "./server-prompt";

export const memoryBox = {
	inject: ["decide", "embed"],
	dependencies: (read) => read.memory(),
	advance: {
		trace: memoryActivationRecord,
		fingerprint: ({ dependencies }) => dependencies.snapshot.freshnessFingerprint,
		// @approved
		// Memory with a disabled block still exposes captured activation evidence in inspection, without recalling.
		withoutBlock: ({ dependencies }) => ({ items: [], trace: dependencies.snapshot.activation }),
		run: async ({ dependencies }, ctx) => {
			try { return memoryItems(await dependencies.recall(ctx)); }
			catch (error) {
				ctx.signal.throwIfAborted();
				throw new InvalidConversationCommandError(`Memory recall failed: ${error instanceof Error ? error.message : "Retry preparation or disable Memory."}`);
			}
		},
	},
} satisfies Box<undefined, MemoryRecall, MemoryActivationRecord, "decide" | "embed">;
