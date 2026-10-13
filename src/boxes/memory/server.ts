import { digestMemory, InvalidConversationCommandError, memoryActivationRecord, type Box, type MemoryActivationRecord, type MemoryRecall, type MemoryRecord } from "../../box-sdk/server";
import { memoryItems } from "./server-prompt";

// @approved
//  Recall reads each passage's record slot itself, so the fold keeps no state.
export const memoryBox = {
	inject: ["llm", "decide", "embed"],
	dependencies: (read) => read.memory(),
	records: { initial: undefined, fold: (state) => state, digest: { window: 4, run: digestMemory } },
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
} satisfies Box<undefined, MemoryRecall, MemoryActivationRecord, "llm" | "decide" | "embed", MemoryRecord>;
