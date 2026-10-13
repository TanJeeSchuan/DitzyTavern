import type { Database } from "bun:sqlite";
import { conversationExists, readCastForMemory } from "../conversation";
import { putMemoryLabels } from "./chat-values";
import type { MemoryIdentityCommand, MemoryLabelMerge, MemoryLabelMergeCommand } from "../../shared/contract/memory";
import { guardRevision } from "../revision";
import { readConversationMemories } from "./memories";
import { InvalidMemoryLabelsError, readMemoryLabelState } from "./labels";

// @approved
//  The Cast-label commands write only the labels: identities and merges apply
//  when claims are shown and recalled, so no stored record changes. Their
//  stale conflicts carry the authoritative `readConversationMemories` read.
const guard = (database: Database, conversationId: number, expectedRevision: number) => (current: { revision: number }) =>
	guardRevision("memories", expectedRevision, current, () => readConversationMemories(database, conversationId));

export function setMemoryIdentity(database: Database, conversationId: number, command: MemoryIdentityCommand): void {
	database.transaction(() => {
		const state = readMemoryLabelState(database, conversationId);
		const participant = readCastForMemory(database, conversationId).find(({ id, removed }) => id === command.participantId && !removed);
		if (!participant) throw new InvalidMemoryLabelsError("This Participant is no longer in the Cast.");
		const identity = command.identity.kind === "plays" ? { ...command.identity, person: command.identity.person.trim() } : command.identity;
		if (identity.kind === "plays" && !identity.person) throw new InvalidMemoryLabelsError("Choose a nonblank person name.");
		if (identity.kind === "themselves") delete state.identities[command.participantId]; else state.identities[command.participantId] = identity;
		putMemoryLabels(database, conversationId, { identities: state.identities, merges: state.merges }, guard(database, conversationId, command.expectedRevision));
	}).immediate();
}

export function mergeMemoryLabels(database: Database, conversationId: number, command: MemoryLabelMergeCommand): void {
	database.transaction(() => {
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
	}).immediate();
}
