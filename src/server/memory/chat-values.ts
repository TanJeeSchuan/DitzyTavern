import type { Database } from "bun:sqlite";
import type { Static } from "@sinclair/typebox";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { putChatValue, readChatValue } from "../box/stored-value";
import { memoryChatSettings, memoryLabels } from "../../shared/contract/memory";

// @approved
//  Memory's per-Chat values in conversation_data under `box:memory`, so
// removing the Box clears them with the rest of its namespace. Each key keeps
// its own revision: the allowance and note share one, the Cast labels another.
type Guard = (current: { revision: number }) => void;

export const readMemoryChatSettings = (database: Database, conversationId: number) =>
	readChatValue(drizzle(database), conversationId, "memory", "settings", memoryChatSettings, { allowance: 2048, note: "" });

export const putMemoryChatSettings = (database: Database, conversationId: number, value: Static<typeof memoryChatSettings>, guard: Guard) =>
	putChatValue(drizzle(database), conversationId, "memory", "settings", JSON.stringify(value), guard);

export const readMemoryLabels = (database: Database, conversationId: number) =>
	readChatValue(drizzle(database), conversationId, "memory", "labels", memoryLabels, { identities: {}, merges: [] });

export const putMemoryLabels = (database: Database, conversationId: number, value: Static<typeof memoryLabels>, guard: Guard) =>
	putChatValue(drizzle(database), conversationId, "memory", "labels", JSON.stringify(value), guard);
