import type { Database } from "bun:sqlite";
import type { Static } from "@sinclair/typebox";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { putChatValue, readChatValue, readMessageAuthors, readParticipants } from "@/box-sdk/server";
import { memoryChatSettings, memoryLabels, type MemoryIdentities, type MemoryLabelMerge } from "./contract";

// @approved
//  Memory's per-Chat values in conversation_data under `box:memory`, so
// removing the Box clears them with the rest of its namespace. Each key keeps
// its own revision: the allowance and note share one, the Cast labels another.
type Guard = (current: { revision: number }) => void;

export const readMemoryChatSettings = (database: Database, conversationId: number) =>
	readChatValue(drizzle(database), conversationId, "memory", "settings", memoryChatSettings, { allowance: 2048, note: "" });

export const putMemoryChatSettings = (database: Database, conversationId: number, value: Static<typeof memoryChatSettings>, guard: Guard) =>
	putChatValue(drizzle(database), conversationId, "memory", { key: "settings", value: JSON.stringify(value) }, guard);

export const putMemoryLabels = (database: Database, conversationId: number, value: Static<typeof memoryLabels>, guard: Guard) =>
	putChatValue(drizzle(database), conversationId, "memory", { key: "labels", value: JSON.stringify(value) }, guard);

export interface MemoryLabelState {
	revision: number;
	merges: MemoryLabelMerge[];
	identities: MemoryIdentities;
	cast: { id: number; names: string[] }[];
}

/** @approved The Chat's Cast labels, each Participant with every name its Messages were captured under, its current name first. */
export const readMemoryLabelState = (database: Database, conversationId: number): MemoryLabelState => {
	const { identities, merges, revision } = readChatValue(drizzle(database), conversationId, "memory", "labels", memoryLabels, { identities: {}, merges: [] });
	const path = readMessageAuthors(database, conversationId);
	const cast = readParticipants(database, conversationId).map(({ id, name }) => ({
		id, names: [...new Set([name, ...path.flatMap((message) => message.authorParticipantId === id && message.author !== null ? [message.author] : [])])],
	}));
	return { revision, merges, identities, cast };
};

/** @approved Whether Memory leaves this author's Messages out: an author who is not in the story is never a source. */
export const isExcludedAuthor = (state: Pick<MemoryLabelState, "identities">, authorParticipantId: number | null): boolean =>
	authorParticipantId !== null && state.identities[authorParticipantId]?.kind === "excluded";
