import type { ConversationMemories, ConversationMemoryAllowance, MemoryCatchup, MemoryCorrectionCommand, MemoryTraceStep } from "../shared/contract/memory";
import { api, domainOutcome } from "./lib/eden";

export async function loadConversationMemories(conversationId: number): Promise<ConversationMemories> {
	const { data, error } = await api.api.conversations({ id: String(conversationId) }).memories.get();
	if (error || data === undefined) throw new Error("Memories could not be loaded.");
	return data;
}

export async function loadMemoryTrace(conversationId: number, variantId: number): Promise<MemoryTraceStep[]> {
	const { data, error } = await api.api.conversations({ id: String(conversationId) }).memories({ variantId: String(variantId) }).trace.get();
	if (error || data === undefined) throw new Error("Memory trace could not be loaded.");
	return data.steps;
}

export async function resetAndReextract(conversationId: number, messageId: number, variantId: number, expectedRevision: number) {
	const { data, error } = await api.api.conversations({ id: String(conversationId) }).memories.reextract.post({ messageId, variantId, expectedRevision });
	if (error === null) return data;
	return domainOutcome(error.value, "Memory work could not be queued.");
}

export async function correctMemory(conversationId: number, command: MemoryCorrectionCommand) {
	const { data, error } = await api.api.conversations({ id: String(conversationId) }).memories.correct.post(command);
	if (error === null) return data;
	return domainOutcome(error.value, "Memory correction could not be saved.");
}

export async function retryMemoryIndex(conversationId: number, messageId: number, variantId: number, expectedRevision: number) {
	const { data, error } = await api.api.conversations({ id: String(conversationId) }).memories.indexing.retry.post({ messageId, variantId, expectedRevision });
	if (error === null) return data;
	return domainOutcome(error.value, "Memory indexing could not be retried.");
}

export async function loadMemoryCatchup(conversationId: number): Promise<MemoryCatchup | null> {
	const { data, error } = await api.api.conversations({ id: String(conversationId) }).memories.catchup.get();
	if (error || data === undefined) throw new Error("History catch-up status could not be loaded.");
	return data.run;
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
	if (error === null) return data;
	return error.status === 409 ? error.value : { outcome: "invalid" as const, reason: "Memory Allowance could not be saved." };
}

export type { ConversationMemories, ConversationMemoryAllowance };
