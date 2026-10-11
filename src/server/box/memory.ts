import { memoryActivationRecord, type MemoryActivationRecord } from "../../shared/contract/memory-recall";
import { memoryItems } from "./memory-prompt";
import { InvalidConversationCommandError } from "../conversation";
import type { Box, MemoryRecall } from "./contract";
import { eq } from "drizzle-orm";
import { conversationMemorySettingsTable } from "../database/schema";

export const memoryBox = {
	inject: ["decide", "embed"],
	dependencies: (read) => read.memory(),
	remove: (db, conversationId) => db.delete(conversationMemorySettingsTable).where(eq(conversationMemorySettingsTable.conversation_id, conversationId)).run(),
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
