import { readConversationSummary, readMessageAuthorsForMemory, readSelectedPathForMemory } from "../conversation";
import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Value } from "@sinclair/typebox/value";
import { conversationMemorySettingsTable } from "../database/schema";
import {
	memoryIdentities,
	memoryLabelMerges,
	type MemoryCandidateJudgment,
	type MemoryIdentities,
	type MemoryLabelMerge,
} from "../../shared/contract/memory";
import { applyMemoryPeople } from "../../shared/memory-identity";

export class InvalidMemoryLabelsError extends Error {
	readonly outcome = "invalid" as const;
	readonly details = { reason: this.message };
}

const connect = (database: Database) => drizzle(database);

const parseMerges = (json: string): MemoryLabelMerge[] => {
	try { return Value.Parse(memoryLabelMerges, JSON.parse(json)); } catch { return []; }
};

export interface MemoryLabelState {
	revision: number;
	merges: MemoryLabelMerge[];
	identities: MemoryIdentities;
	cast: { id: number; names: string[] }[];
}

export const readMemoryLabelState = (database: Database, conversationId: number): MemoryLabelState => {
	const row = connect(database).select().from(conversationMemorySettingsTable).where(eq(conversationMemorySettingsTable.conversation_id, conversationId)).get();
	const cast = new Map<number, { id: number; names: string[] }>();
	const path = readMessageAuthorsForMemory(database, conversationId);
	const names = readConversationSummary(database, conversationId)?.cast ?? [];
	for (const { id, name } of names) {
		cast.set(id, { id, names: [...new Set([name, ...path.flatMap((message) => message.authorParticipantId === id && message.author !== null ? [message.author] : [])])] });
	}
	return {
		revision: row?.label_revision ?? 0,
		merges: parseMerges(row?.label_merges ?? "[]"),
		identities: Value.Parse(memoryIdentities, JSON.parse(row?.identities ?? "{}")),
		cast: [...cast.values()],
	};
};

export const applyMemoryLabelRules = (claims: readonly MemoryCandidateJudgment[], state: MemoryLabelState): MemoryCandidateJudgment[] =>
	claims.map((claim) => ({ ...claim, people: applyMemoryPeople(claim.people, state.cast, state.identities, state.merges) }));

export const isExcludedMemorySource = (database: Database, conversationId: number, messageId: number) => {
	const author = readSelectedPathForMemory(database, conversationId, messageId)?.find((message) => message.messageId === messageId)?.authorParticipantId;
	if (author === undefined || author === null) return false;
	const settings = connect(database).select({ identities: conversationMemorySettingsTable.identities }).from(conversationMemorySettingsTable)
		.where(eq(conversationMemorySettingsTable.conversation_id, conversationId)).get();
	return Value.Parse(memoryIdentities, JSON.parse(settings?.identities ?? "{}"))[author]?.kind === "excluded";
};
