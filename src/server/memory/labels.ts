import { readCastForMemory, readMessageAuthorsForMemory, readSelectedPathForMemory } from "../conversation";
import type { Database } from "bun:sqlite";
import { readMemoryLabels } from "./chat-values";
import {
	type MemoryCandidateJudgment,
	type MemoryIdentities,
	type MemoryLabelMerge,
} from "../../shared/contract/memory";
import { applyMemoryPeople } from "../../shared/memory-identity";

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

export const applyMemoryLabelRules = (claims: readonly MemoryCandidateJudgment[], state: MemoryLabelState): MemoryCandidateJudgment[] =>
	claims.map((claim) => ({ ...claim, people: applyMemoryPeople(claim.people, state.cast, state.identities, state.merges) }));

export const isExcludedMemorySource = (database: Database, conversationId: number, messageId: number) => {
	const author = readSelectedPathForMemory(database, conversationId, { messageId, preceding: 0 })?.find((message) => message.messageId === messageId)?.authorParticipantId;
	if (author === undefined || author === null) return false;
	return readMemoryLabels(database, conversationId).identities[author]?.kind === "excluded";
};
