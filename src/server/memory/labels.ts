import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Value } from "@sinclair/typebox/value";
import { conversationMemorySettingsTable, conversationTable, memoryCollectionTable } from "../database/schema";
import { memoryCandidates, memoryLabelMerges, type MemoryCandidateJudgment, type MemoryLabelMerge, type MemoryLabelMergeCommand } from "../../shared/contract/memory";

export class StaleMemoryLabelsError extends Error {}

const parseMerges = (json: string): MemoryLabelMerge[] => {
	try { return Value.Parse(memoryLabelMerges, JSON.parse(json)); } catch { return []; }
};

export const readMemoryLabelState = (database: Database, conversationId: number) => {
	const row = drizzle(database)
		.select({ revision: conversationMemorySettingsTable.label_revision, merges: conversationMemorySettingsTable.label_merges })
		.from(conversationMemorySettingsTable)
		.where(eq(conversationMemorySettingsTable.conversation_id, conversationId))
		.get();
	return { revision: row?.revision ?? 0, merges: parseMerges(row?.merges ?? "[]") };
};

export const applyMemoryLabelMerges = (claims: readonly MemoryCandidateJudgment[], merges: readonly MemoryLabelMerge[]): MemoryCandidateJudgment[] => {
	const names = new Map(merges.map(({ from, to }) => [from, to]));
	return claims.map((claim) => ({ ...claim, people: [...new Set(claim.people.map((person) => names.get(person) ?? person))] }));
};

export function mergeMemoryLabels(database: Database, conversationId: number, command: MemoryLabelMergeCommand): void {
	database.transaction(() => {
		const db = drizzle(database);
		if (!db.select({ id: conversationTable.id }).from(conversationTable).where(eq(conversationTable.id, conversationId)).get()) throw new Error("This Chat no longer exists.");
		const state = readMemoryLabelState(database, conversationId);
		if (state.revision !== command.expectedRevision) throw new StaleMemoryLabelsError();
		const destination = command.destination.trim();
		const labels = new Set(command.labels);
		if (!destination || destination.length > 1024 || labels.size === 0 || [...labels].some((label) => !label.trim()) || [...labels].every((label) => label === destination)) throw new Error("Choose labels and a different destination name.");
		if (state.merges.some(({ from, to }) => labels.has(from) || (from === destination && !labels.has(to)))) throw new Error("A selected name has already been merged. Refresh Memories and choose its current label.");
		const merges = new Map(state.merges.map(({ from, to }) => [from, labels.has(to) ? destination : to]));
		for (const label of labels) merges.set(label, destination);
		merges.delete(destination);
		const next: MemoryLabelMerge[] = [...merges].map(([from, to]) => ({ from, to }));
		const rows = db.select().from(memoryCollectionTable).where(eq(memoryCollectionTable.conversation_id, conversationId)).all();
		for (const row of rows) {
			const claims = Value.Parse(memoryCandidates, JSON.parse(row.claims_json));
			const updated = applyMemoryLabelMerges(claims, next);
			if (JSON.stringify(claims) === JSON.stringify(updated)) continue;
			db.update(memoryCollectionTable).set({ claims_json: JSON.stringify(updated), revision: row.revision + 1, updated_at: new Date().toISOString() }).where(eq(memoryCollectionTable.variant_id, row.variant_id)).run();
		}
		db.insert(conversationMemorySettingsTable)
			.values({ conversation_id: conversationId, label_merges: JSON.stringify(next), label_revision: state.revision + 1 })
			.onConflictDoUpdate({
				target: conversationMemorySettingsTable.conversation_id,
				set: { label_merges: JSON.stringify(next), label_revision: state.revision + 1 },
			})
			.run();
	}).immediate();
}
