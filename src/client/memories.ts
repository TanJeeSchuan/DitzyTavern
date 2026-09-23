import type { ConversationMemories, ConversationMemoryAllowance, MemoryCatchup } from "../shared/contract/memory";
import { Value } from "@sinclair/typebox/value";
import { memoryInvalid, conversationMemoryAllowanceConflict, memoryCorrectionConflict, memoryIndexRetryConflict, memoryCatchup } from "../shared/contract/memory";
import { api } from "./lib/eden";

export async function loadConversationMemories(conversationId: number): Promise<ConversationMemories> {
	const { data, error } = await api.api.conversations({ id: String(conversationId) }).memories.get();
	if (error || data === undefined) throw new Error("Memories could not be loaded.");
	return data;
}

export async function resetAndReextract(conversationId: number, messageId: number): Promise<{ outcome: "queued" } | { outcome: "invalid"; reason: string }> {
	const { data, error } = await api.api.conversations({ id: String(conversationId) }).memories.reextract.post({ messageId });
	if (data !== undefined && data !== null) return data;
	const value = error?.value;
	return value !== undefined && Value.Check(memoryInvalid, value)
		? Value.Parse(memoryInvalid, value)
		: { outcome: "invalid", reason: "Memory work could not be queued." };
}

export async function correctMemory(conversationId: number, messageId: number, variantId: number, expectedRevision: number, index: number, operation: "edit" | "remove", replacement?: { claim: string; attribution: string; people: string[] }) {
	const { data, error } = await api.api.conversations({ id: String(conversationId) }).memories.correct.post({ messageId, variantId, expectedRevision, index, operation, ...replacement });
	if (data !== undefined && data !== null) return data;
	const value = error?.value;
	if (value !== undefined && Value.Check(memoryCorrectionConflict, value)) return Value.Parse(memoryCorrectionConflict, value);
	const invalid = value !== undefined && Value.Check(memoryInvalid, value) ? Value.Parse(memoryInvalid, value) : { reason: "Memory correction could not be saved." };
	return { outcome: "invalid" as const, reason: invalid.reason };
}

export async function retryMemoryIndex(conversationId: number, messageId: number, variantId: number, expectedRevision: number) {
	const { data, error } = await api.api.conversations({ id: String(conversationId) }).memories.indexing.retry.post({ messageId, variantId, expectedRevision });
	if (data !== undefined && data !== null) return data;
	const value = error?.value;
	if (value !== undefined && Value.Check(memoryIndexRetryConflict, value)) return Value.Parse(memoryIndexRetryConflict, value);
	const invalid = value !== undefined && Value.Check(memoryInvalid, value) ? Value.Parse(memoryInvalid, value) : { reason: "Memory indexing could not be retried." };
	return { outcome: "invalid" as const, reason: invalid.reason };
}

export async function loadMemoryCatchup(conversationId: number): Promise<MemoryCatchup | null> {
	const { data, error } = await api.api.conversations({ id: String(conversationId) }).memories.catchup.get();
	if (error || data === undefined) throw new Error("History catch-up status could not be loaded.");
	if (data.run === null) return null;
	if (!Value.Check(memoryCatchup, data.run)) throw new Error("History catch-up status has an invalid shape.");
	return Value.Parse(memoryCatchup, data.run);
}
export async function startMemoryCatchup(conversationId: number): Promise<MemoryCatchup> {
	const { data, error } = await api.api.conversations({ id: String(conversationId) }).memories.catchup.post({});
	if (error || data === undefined) throw new Error(error?.value && "reason" in error.value ? String(error.value.reason) : "History catch-up could not be started.");
	return data;
}
export async function cancelMemoryCatchup(conversationId: number, runId: number): Promise<MemoryCatchup> {
	const { data, error } = await api.api.conversations({ id: String(conversationId) }).memories.catchup({ runId: String(runId) }).delete();
	if (error || data === undefined) throw new Error("History catch-up could not be cancelled.");
	return data;
}

export type { MemoryCatchup };

export async function loadMemoryAllowance(conversationId: number): Promise<ConversationMemoryAllowance> {
	const { data, error } = await api.api.conversations({ id: String(conversationId) })["memory-allowance"].get();
	if (error || data === undefined) throw new Error("Memory Allowance could not be loaded.");
	return data;
}

export async function saveMemoryAllowance(conversationId: number, expectedRevision: number, allowance: number) {
	const { data, error } = await api.api.conversations({ id: String(conversationId) })["memory-allowance"].post({ expectedRevision, allowance });
	if (data !== undefined && data !== null) return data;
	const value = error?.value;
	if (value !== undefined && Value.Check(conversationMemoryAllowanceConflict, value)) return Value.Parse(conversationMemoryAllowanceConflict, value);
	return { outcome: "invalid" as const, reason: "Memory Allowance could not be saved." };
}

export type { ConversationMemories, ConversationMemoryAllowance };
