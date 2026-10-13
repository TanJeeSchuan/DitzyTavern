import { InvalidConversationCommandError, type Box } from "@/box-sdk/server";
import { memoryActivationRecord, type MemoryActivationRecord, type MemoryRecord } from "./contract";
import { digestMemory } from "./server-extraction";
import { memoryItems } from "./server-prompt";
import { memoryRoutes } from "./server-routes";
import { captureMemoryRecallSnapshot, evaluateMemoryRecallSnapshot, type MemoryRecallSnapshot } from "./server-recall";

// @approved
//  Recall reads each passage's record slot itself, so the fold keeps no state.
const memoryBox = {
	inject: ["llm", "decide", "embed"],
	dependencies: captureMemoryRecallSnapshot,
	records: { initial: undefined, fold: (state) => state, digest: { window: 4, run: digestMemory } },
	advance: {
		trace: memoryActivationRecord,
		fingerprint: ({ dependencies }) => dependencies.freshnessFingerprint,
		run: async ({ dependencies }, ctx) => {
			try { return memoryItems(await evaluateMemoryRecallSnapshot(dependencies, ctx)); }
			catch (error) {
				ctx.signal.throwIfAborted();
				throw new InvalidConversationCommandError(`Memory recall failed: ${error instanceof Error ? error.message : "Retry preparation or disable Memory."}`);
			}
		},
	},
	routes: memoryRoutes,
} satisfies Box<undefined, MemoryRecallSnapshot, MemoryActivationRecord, "llm" | "decide" | "embed", MemoryRecord>;
export default memoryBox;
