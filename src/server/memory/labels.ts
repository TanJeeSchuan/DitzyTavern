import { readMessageAuthorsForMemory, readSelectedPathForMemory } from "../conversation";
import type { Database } from "bun:sqlite";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Value } from "@sinclair/typebox/value";
import { conversationMemorySettingsTable, conversationTable, memoryCollectionTable, participantTable } from "../database/schema";
import {
	memoryCandidates,
	memoryIdentities,
	memoryLabelMerges,
	type MemoryCandidateJudgment,
	type MemoryIdentityCommand,
	type MemoryLabelMerge,
	type MemoryLabelMergeCommand,
} from "../../shared/contract/memory";
import { applyMemoryPeople } from "../../shared/memory-identity";
import { abortMemoryWork } from "./work";

export class StaleMemoryLabelsError extends Error {
	readonly outcome = "conflict" as const;
}

export class InvalidMemoryLabelsError extends Error {
	readonly outcome = "invalid" as const;
	readonly details = { reason: this.message };
}

const parseMerges = (json: string): MemoryLabelMerge[] => {
	try { return Value.Parse(memoryLabelMerges, JSON.parse(json)); } catch { return []; }
};

export const readMemoryLabelState = (database: Database, conversationId: number) => {
	const db = drizzle(database);
	const row = db.select().from(conversationMemorySettingsTable).where(eq(conversationMemorySettingsTable.conversation_id, conversationId)).get();
	const cast = new Map<number, { id: number; names: string[] }>();
	const path = readMessageAuthorsForMemory(database, conversationId);
	const names = db.select({ id: participantTable.id, name: participantTable.name }).from(participantTable)
		.where(eq(participantTable.conversation_id, conversationId)).orderBy(asc(participantTable.position), asc(participantTable.id)).all();
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

export const applyMemoryLabelRules = (claims: readonly MemoryCandidateJudgment[], state: ReturnType<typeof readMemoryLabelState>): MemoryCandidateJudgment[] =>
	claims.map((claim) => ({ ...claim, people: applyMemoryPeople(claim.people, state.cast, state.identities, state.merges) }));

export const isExcludedMemorySource = (database: Database, conversationId: number, messageId: number) => {
	const author = readSelectedPathForMemory(database, conversationId, messageId)?.find((message) => message.messageId === messageId)?.authorParticipantId;
	if (author === undefined || author === null) return false;
	const settings = drizzle(database).select({ identities: conversationMemorySettingsTable.identities }).from(conversationMemorySettingsTable)
		.where(eq(conversationMemorySettingsTable.conversation_id, conversationId)).get();
	return Value.Parse(memoryIdentities, JSON.parse(settings?.identities ?? "{}"))[author]?.kind === "excluded";
};

const rewriteCollections = (database: Database, conversationId: number, state: ReturnType<typeof readMemoryLabelState>) => {
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

export function setMemoryIdentity(database: Database, conversationId: number, command: MemoryIdentityCommand): void {
	const removed = database.transaction(() => {
		const db = drizzle(database);
		const state = readMemoryLabelState(database, conversationId);
		if (state.revision !== command.expectedRevision) throw new StaleMemoryLabelsError();
		const participant = db
			.select({ id: participantTable.id })
			.from(participantTable)
			.where(and(eq(participantTable.id, command.participantId), eq(participantTable.conversation_id, conversationId), isNull(participantTable.deleted_at)))
			.get();
		if (!participant) throw new InvalidMemoryLabelsError("This Participant is no longer in the Cast.");
		const identity = command.identity.kind === "plays" ? { ...command.identity, person: command.identity.person.trim() } : command.identity;
		if (identity.kind === "plays" && !identity.person) throw new InvalidMemoryLabelsError("Choose a nonblank person name.");
		if (identity.kind === "themselves") delete state.identities[command.participantId]; else state.identities[command.participantId] = identity;
		const values = { identities: JSON.stringify(state.identities), label_revision: state.revision + 1 };
		db.insert(conversationMemorySettingsTable)
			.values({ conversation_id: conversationId, ...values })
			.onConflictDoUpdate({ target: conversationMemorySettingsTable.conversation_id, set: values })
			.run();
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
		if (!db.select({ id: conversationTable.id }).from(conversationTable).where(eq(conversationTable.id, conversationId)).get()) throw new InvalidMemoryLabelsError("This Chat no longer exists.");
		const state = readMemoryLabelState(database, conversationId);
		if (state.revision !== command.expectedRevision) throw new StaleMemoryLabelsError();
		const destination = command.destination.trim();
		const labels = new Set(command.labels);
		if (!destination || destination.length > 1024 || labels.size === 0 || [...labels].some((label) => !label.trim()) || [...labels].every((label) => label === destination)) throw new InvalidMemoryLabelsError("Choose labels and a different destination name.");
		if (state.merges.some(({ from, to }) => labels.has(from) || (from === destination && !labels.has(to)))) throw new InvalidMemoryLabelsError("A selected name has already been merged. Refresh Memories and choose its current label.");
		const merges = new Map(state.merges.map(({ from, to }) => [from, labels.has(to) ? destination : to]));
		for (const label of labels) merges.set(label, destination);
		merges.delete(destination);
		const next: MemoryLabelMerge[] = [...merges].map(([from, to]) => ({ from, to }));
		rewriteCollections(database, conversationId, { ...state, merges: next });
		db.insert(conversationMemorySettingsTable)
			.values({ conversation_id: conversationId, label_merges: JSON.stringify(next), label_revision: state.revision + 1 })
			.onConflictDoUpdate({
				target: conversationMemorySettingsTable.conversation_id,
				set: { label_merges: JSON.stringify(next), label_revision: state.revision + 1 },
			})
			.run();
	}).immediate();
}
