import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	conversationExists, effectiveRecord, hasAutomaticRecord, hasDigestError, readBoxCatchUp, readBoxDecision, readBoxLifecycles,
	readChatVariants, readConversationRevision, readMessageAuthors, readParticipants, readRecordSlots,
} from "@/box-sdk/server";
import { memoryRecord, type ConversationMemories, type ConversationMemoryAllowanceCommand, type MemoryIdentityCommand, type MemoryLabelMerge, type MemoryLabelMergeCommand } from "./contract";
import { isExcludedAuthor, putMemoryChatSettings, putMemoryLabels, readMemoryChatSettings, readMemoryLabelState } from "./server-chat";
import { InvalidMemoryCommandError, memoryGuard } from "./server-errors";
import { readMemoryEmbedding } from "./server-settings";

// @approved
//  The Memories panel's read: every selected nonempty Variant on the path,
//  then each unselected Variant that still holds Memories, each with its
//  Memory record slot. An author who is not in the story is left out.
export function readConversationMemories(database: Database, conversationId: number): ConversationMemories {
	const state = readMemoryLabelState(database, conversationId);
	const variants = readChatVariants(database, conversationId);
	const slots = readRecordSlots(drizzle(database), "memory", memoryRecord, readBoxLifecycles(drizzle(database), conversationId).memory?.instance, variants.map(({ variantId }) => variantId));
	const sources = variants
		.filter((variant) => !isExcludedAuthor(state, variant.authorParticipantId)
			&& (variant.selected ? variant.content.trim() !== "" : effectiveRecord(slots.get(variant.variantId)) !== undefined))
		.sort((left, right) => Number(right.selected) - Number(left.selected) || left.position - right.position || left.variantPosition - right.variantPosition)
		.map(({ messageId, variantId, selected, content }) => {
			const slot = slots.get(variantId);
			return {
				messageId, variantId, selected,
				claims: effectiveRecord(slot)?.claims ?? null,
				overridden: slot?.writer !== undefined,
				digested: hasAutomaticRecord(slot, content),
				error: hasDigestError(slot, content) ? slot?.error?.message ?? null : null,
			};
		});
	return {
		revision: readConversationRevision(database, conversationId) ?? 0,
		labelRevision: state.revision,
		identities: state.identities,
		cast: state.cast,
		labelMerges: state.merges,
		sources,
		path: readMessageAuthors(database, conversationId),
		digestReady: readBoxDecision(database, "memory").status.kind === "ready",
		embeddingReady: readMemoryEmbedding(database).spaceKey !== "",
		catchUp: readBoxCatchUp(database, conversationId, "memory"),
	};
}

const updateChatSettings = (database: Database, conversationId: number, expectedRevision: string, patch: { allowance: number } | { note: string }) =>
	database.transaction(() => {
		if (!conversationExists(database, conversationId)) throw new InvalidMemoryCommandError("This Chat no longer exists.");
		const current = readMemoryChatSettings(database, conversationId);
		const { revision: _revision, ...value } = current;
		putMemoryChatSettings(database, conversationId, { ...value, ...patch }, memoryGuard(expectedRevision, (actualRevision) => ({ expectedRevision, actualRevision, currentSettings: current })));
		return readMemoryChatSettings(database, conversationId);
	}).immediate();

export function setMemoryAllowance(database: Database, conversationId: number, command: ConversationMemoryAllowanceCommand) {
	if (!Number.isSafeInteger(command.allowance) || command.allowance < 0) {
		throw new InvalidMemoryCommandError("Memory Allowance must be a non-negative whole number of estimated tokens.");
	}
	return updateChatSettings(database, conversationId, command.expectedRevision, { allowance: command.allowance });
}

export function setMemoryNote(database: Database, conversationId: number, expectedRevision: string, note: string) {
	const memoryNote = note.trim();
	if (memoryNote.length > 2_000) throw new InvalidMemoryCommandError("The Memory note is limited to 2,000 characters.");
	return updateChatSettings(database, conversationId, expectedRevision, { note: memoryNote });
}

// @approved
//  The Cast-label commands write only the labels: identities and merges apply
//  when claims are shown and recalled, so no stored record changes. Their
//  stale conflicts carry the authoritative `readConversationMemories` read.
const labelsGuard = (database: Database, conversationId: number, expectedRevision: string) =>
	memoryGuard(expectedRevision, () => ({ memories: readConversationMemories(database, conversationId) }));

export function setMemoryIdentity(database: Database, conversationId: number, command: MemoryIdentityCommand): void {
	database.transaction(() => {
		const state = readMemoryLabelState(database, conversationId);
		const participant = readParticipants(database, conversationId).find(({ id, removed }) => id === command.participantId && !removed);
		if (!participant) throw new InvalidMemoryCommandError("This Participant is no longer in the Cast.");
		const identity = command.identity.kind === "plays" ? { ...command.identity, person: command.identity.person.trim() } : command.identity;
		if (identity.kind === "plays" && !identity.person) throw new InvalidMemoryCommandError("Choose a nonblank person name.");
		if (identity.kind === "themselves") delete state.identities[command.participantId]; else state.identities[command.participantId] = identity;
		putMemoryLabels(database, conversationId, { identities: state.identities, merges: state.merges }, labelsGuard(database, conversationId, command.expectedRevision));
	}).immediate();
}

export function mergeMemoryLabels(database: Database, conversationId: number, command: MemoryLabelMergeCommand): void {
	database.transaction(() => {
		if (!conversationExists(database, conversationId)) throw new InvalidMemoryCommandError("This Chat no longer exists.");
		const state = readMemoryLabelState(database, conversationId);
		const destination = command.destination.trim();
		const labels = new Set(command.labels);
		if (!destination || destination.length > 1024 || labels.size === 0 || [...labels].some((label) => !label.trim()) || [...labels].every((label) => label === destination)) throw new InvalidMemoryCommandError("Choose labels and a different destination name.");
		const mergedLabel = state.merges.some(({ from, to }) => labels.has(from) || (from === destination && !labels.has(to)));
		if (mergedLabel) throw new InvalidMemoryCommandError("A selected name has already been merged. Refresh Memories and choose its current label.");
		const merges = new Map(state.merges.map(({ from, to }) => [from, labels.has(to) ? destination : to]));
		for (const label of labels) merges.set(label, destination);
		merges.delete(destination);
		const next: MemoryLabelMerge[] = [...merges].map(([from, to]) => ({ from, to }));
		putMemoryLabels(database, conversationId, { identities: state.identities, merges: next }, labelsGuard(database, conversationId, command.expectedRevision));
	}).immediate();
}
