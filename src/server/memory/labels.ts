import { readCastForMemory, readMessageAuthorsForMemory } from "../conversation";
import type { Database } from "bun:sqlite";
import { readMemoryLabels } from "./chat-values";
import type { MemoryIdentities, MemoryLabelMerge } from "../../shared/contract/memory";

export class InvalidMemoryLabelsError extends Error {
	readonly outcome = "invalid" as const;
	readonly details = { reason: this.message };
}

export interface MemoryLabelState {
	revision: number;
	merges: MemoryLabelMerge[];
	identities: MemoryIdentities;
	cast: { id: number; names: string[] }[];
}

export const readMemoryLabelState = (database: Database, conversationId: number): MemoryLabelState => {
	const { identities, merges, revision } = readMemoryLabels(database, conversationId);
	const cast = new Map<number, { id: number; names: string[] }>();
	const path = readMessageAuthorsForMemory(database, conversationId);
	for (const { id, name } of readCastForMemory(database, conversationId)) {
		cast.set(id, { id, names: [...new Set([name, ...path.flatMap((message) => message.authorParticipantId === id && message.author !== null ? [message.author] : [])])] });
	}
	return {
		revision,
		merges,
		identities,
		cast: [...cast.values()],
	};
};

/** @approved Whether Memory leaves this author's Messages out: an author who is not in the story is never a source. */
export const isExcludedAuthor = (state: Pick<MemoryLabelState, "identities">, authorParticipantId: number | null): boolean =>
	authorParticipantId !== null && state.identities[authorParticipantId]?.kind === "excluded";
