import type { Database } from "bun:sqlite";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Value } from "@sinclair/typebox/value";
import { conversationExists, readCastForMemory, readMessageAuthorsForMemory } from "../conversation";
import { memoryCollectionTable } from "../database/schema";
import { putMemoryLabels } from "./chat-values";
import {
	memoryCandidates,
	type MemoryIdentityCommand,
	type MemoryLabelMerge,
	type MemoryLabelMergeCommand,
} from "../../shared/contract/memory";
import { guardRevision } from "../revision";
import { readConversationMemories } from "./collections";
import { applyMemoryLabelRules, InvalidMemoryLabelsError, readMemoryLabelState, type MemoryLabelState } from "./labels";
import { abortMemoryWork } from "./work";

// @approved
//  The Cast-label commands sit between the two seams: the label state is read
//  through `labels`, and their stale conflicts carry the authoritative
//  `readConversationMemories` read from `collections`.
const rewriteCollections = (database: Database, conversationId: number, state: MemoryLabelState) => {
	const db = drizzle(database);
	for (const row of db.select().from(memoryCollectionTable).where(eq(memoryCollectionTable.conversation_id, conversationId)).all()) {
		const claims = Value.Parse(memoryCandidates, JSON.parse(row.claims_json));
		const updated = applyMemoryLabelRules(claims, state);
		if (JSON.stringify(claims) === JSON.stringify(updated)) continue;
		db.update(memoryCollectionTable)
			.set({ claims_json: JSON.stringify(updated), revision: row.revision + 1, updated_at: new Date().toISOString() })
			.where(eq(memoryCollectionTable.variant_id, row.variant_id))
			.run();
	}
};

const guard = (database: Database, conversationId: number, expectedRevision: number) => (current: { revision: number }) =>
	guardRevision("memories", expectedRevision, current, () => readConversationMemories(database, conversationId));

export function setMemoryIdentity(database: Database, conversationId: number, command: MemoryIdentityCommand): void {
	const removed = database.transaction(() => {
		const db = drizzle(database);
		const state = readMemoryLabelState(database, conversationId);
		const participant = readCastForMemory(database, conversationId).find(({ id, removed }) => id === command.participantId && !removed);
		if (!participant) throw new InvalidMemoryLabelsError("This Participant is no longer in the Cast.");
		const identity = command.identity.kind === "plays" ? { ...command.identity, person: command.identity.person.trim() } : command.identity;
		if (identity.kind === "plays" && !identity.person) throw new InvalidMemoryLabelsError("Choose a nonblank person name.");
		if (identity.kind === "themselves") delete state.identities[command.participantId]; else state.identities[command.participantId] = identity;
		putMemoryLabels(database, conversationId, { identities: state.identities, merges: state.merges }, guard(database, conversationId, command.expectedRevision));
		const excluded = Object.entries(state.identities).flatMap(([id, value]) => value.kind === "excluded" ? [Number(id)] : []);
		const messages = readMessageAuthorsForMemory(database, conversationId).filter((message) => message.authorParticipantId !== null && excluded.includes(message.authorParticipantId)).map((message) => message.messageId);
		const removed = messages.length === 0 ? [] : db
			.delete(memoryCollectionTable)
			.where(and(eq(memoryCollectionTable.conversation_id, conversationId), inArray(memoryCollectionTable.message_id, messages)))
			.returning({ id: memoryCollectionTable.variant_id })
			.all();
		rewriteCollections(database, conversationId, state);
		return removed.map(({ id }) => id);
	}).immediate();
	abortMemoryWork(database, removed);
}

export function mergeMemoryLabels(database: Database, conversationId: number, command: MemoryLabelMergeCommand): void {
	database.transaction(() => {
		const db = drizzle(database);
		if (!conversationExists(database, conversationId)) throw new InvalidMemoryLabelsError("This Chat no longer exists.");
		const state = readMemoryLabelState(database, conversationId);
		const destination = command.destination.trim();
		const labels = new Set(command.labels);
		if (!destination || destination.length > 1024 || labels.size === 0 || [...labels].some((label) => !label.trim()) || [...labels].every((label) => label === destination)) throw new InvalidMemoryLabelsError("Choose labels and a different destination name.");
		const mergedLabel = state.merges.some(({ from, to }) => labels.has(from) || (from === destination && !labels.has(to)));
		if (mergedLabel) throw new InvalidMemoryLabelsError("A selected name has already been merged. Refresh Memories and choose its current label.");
		const merges = new Map(state.merges.map(({ from, to }) => [from, labels.has(to) ? destination : to]));
		for (const label of labels) merges.set(label, destination);
		merges.delete(destination);
		const next: MemoryLabelMerge[] = [...merges].map(([from, to]) => ({ from, to }));
		putMemoryLabels(database, conversationId, { identities: state.identities, merges: next }, guard(database, conversationId, command.expectedRevision));
		rewriteCollections(database, conversationId, { ...state, merges: next });
	}).immediate();
}
