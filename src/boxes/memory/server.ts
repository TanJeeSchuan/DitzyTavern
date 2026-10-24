import { InvalidConversationCommandError, type Box } from "@/box-sdk/server";
import { memoryActivationRecord, type MemoryActivationRecord, type MemoryRecord } from "./contract";
import { digestMemory } from "./server-extraction";
import { memoryItems } from "./server-prompt";
import { memoryRoutes } from "./server-routes";
import { captureMemoryRecallSnapshot, evaluateMemoryRecallSnapshot, type MemoryRecallSnapshot } from "./server-recall";

// @approved
//  Recall reads each passage's record slot from what the host captured, so
//  Memory folds no state.
const memoryBox = {
	dependencies: captureMemoryRecallSnapshot,
	records: { digest: { window: 4, run: digestMemory } },
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
} satisfies Box<undefined, MemoryRecallSnapshot, MemoryActivationRecord, MemoryRecord>;
export default memoryBox;
