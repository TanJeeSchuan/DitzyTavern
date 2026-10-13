import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { conversationExists, readConversationRevision, readMessageAuthorsForMemory, readVariantsForMemory } from "../conversation";
import { readBoxCatchUp } from "../box/digest";
import { resolveBoxDecision } from "../box/decision-settings";
import { effectiveRecord, hasAutomaticRecord, hasDigestError, readRecordSlots } from "../box/records";
import { readBoxInstances } from "../box/setup";
import type { ConversationMemories } from "../../shared/contract/memory";
import { guardRevision } from "../revision";
import { putMemoryChatSettings, readMemoryChatSettings } from "./chat-values";
import { readMemoryEmbeddingConfiguration } from "./indexing";
import { isExcludedAuthor, readMemoryLabelState } from "./labels";

class InvalidMemorySettingsError extends Error {
	readonly outcome = "invalid" as const;
	readonly details = { reason: this.message };

	constructor(message: string) {
		super(message);
		this.name = "InvalidMemorySettingsError";
	}
}

// @approved
//  The Memories panel's read: every selected nonempty Variant on the path,
//  then each unselected Variant that still holds Memories, each with its
//  Memory record slot. An author who is not in the story is left out.
export function readConversationMemories(database: Database, conversationId: number): ConversationMemories {
	const state = readMemoryLabelState(database, conversationId);
	const variants = readVariantsForMemory(database, conversationId);
	const slots = readRecordSlots(drizzle(database), "memory", readBoxInstances(drizzle(database), conversationId).memory, variants.map(({ variantId }) => variantId));
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
		path: readMessageAuthorsForMemory(database, conversationId),
		digestReady: resolveBoxDecision(database, "memory").kind === "ready",
		embeddingReady: readMemoryEmbeddingConfiguration(database).spaceKey !== "",
		catchUp: readBoxCatchUp(database, conversationId, "memory"),
	};
}

export const readMemoryAllowance = (database: Database, conversationId: number) => readMemoryChatSettings(database, conversationId);

const updateChatSettings = (database: Database, conversationId: number, expectedRevision: number, patch: { allowance: number } | { note: string }) =>
	database.transaction(() => {
		if (!conversationExists(database, conversationId)) throw new InvalidMemorySettingsError("This Chat no longer exists.");
		const current = readMemoryChatSettings(database, conversationId);
		const { revision: _revision, ...value } = current;
		putMemoryChatSettings(database, conversationId, { ...value, ...patch }, (row) => guardRevision("settings", expectedRevision, row, () => current));
		return readMemoryChatSettings(database, conversationId);
	}).immediate();

export function setMemoryAllowance(database: Database, conversationId: number, expectedRevision: number, allowance: number) {
	if (!Number.isSafeInteger(allowance) || allowance < 0) {
		throw new InvalidMemorySettingsError("Memory Allowance must be a non-negative whole number of estimated tokens.");
	}
	return updateChatSettings(database, conversationId, expectedRevision, { allowance });
}

export function setMemoryNote(database: Database, conversationId: number, expectedRevision: number, note: string) {
	const memoryNote = note.trim();
	if (memoryNote.length > 2_000) throw new InvalidMemorySettingsError("The Memory note is limited to 2,000 characters.");
	return updateChatSettings(database, conversationId, expectedRevision, { note: memoryNote });
}
