import type { ConversationMemories, ConversationMemoryAllowance, MemoryCatchup, MemoryCorrectionCommand, MemoryLabelMergeCommand, MemorySourceTarget, MemoryTraceStep } from "../shared/contract/memory";
import { api, domainOutcome } from "./lib/eden";

const conversation = (conversationId: number) => api.api.conversations({ id: String(conversationId) });

export async function mergeMemoryLabels(conversationId: number, command: MemoryLabelMergeCommand) {
	const { data, error } = await conversation(conversationId).memories["merge-labels"].post(command);
	return error === null ? data : domainOutcome(error.value, "Labels could not be merged.");
}

export async function loadConversationMemories(conversationId: number): Promise<ConversationMemories> {
	const { data, error } = await conversation(conversationId).memories.get();
	if (error || data === undefined) throw new Error("Memories could not be loaded.");
	return data;
}

export async function loadMemoryTrace(conversationId: number, variantId: number): Promise<MemoryTraceStep[]> {
	const { data, error } = await conversation(conversationId).memories({ variantId: String(variantId) }).trace.get();
	if (error || data === undefined) throw new Error("Memory trace could not be loaded.");
	return data.steps;
}

export async function loadMemoryCatchup(conversationId: number): Promise<MemoryCatchup | null> {
	const { data, error } = await conversation(conversationId).memories.catchup.get();
	if (error || data === undefined) throw new Error("History catch-up status could not be loaded.");
	return data.run;
}

export async function loadMemoryAllowance(conversationId: number): Promise<ConversationMemoryAllowance> {
	const { data, error } = await conversation(conversationId)["memory-allowance"].get();
	if (error || data === undefined) throw new Error("Memory Allowance could not be loaded.");
	return data;
}

export async function resetAndReextract(conversationId: number, target: MemorySourceTarget) {
	const { data, error } = await conversation(conversationId).memories.reextract.post(target);
	return error === null ? data : domainOutcome(error.value, "Memory work could not be queued.");
}

export async function correctMemory(conversationId: number, command: MemoryCorrectionCommand) {
	const { data, error } = await conversation(conversationId).memories.correct.post(command);
	return error === null ? data : domainOutcome(error.value, "Memory correction could not be saved.");
}

export async function retryMemoryIndex(conversationId: number, target: MemorySourceTarget) {
	const { data, error } = await conversation(conversationId).memories.indexing.retry.post(target);
	return error === null ? data : domainOutcome(error.value, "Memory indexing could not be retried.");
}

export async function startMemoryCatchup(conversationId: number) {
	const { data, error } = await conversation(conversationId).memories.catchup.post({});
	return error === null ? data : domainOutcome(error.value, "History catch-up could not be started.");
}

export async function cancelMemoryCatchup(conversationId: number, runId: number) {
	const { data, error } = await conversation(conversationId).memories.catchup({ runId: String(runId) }).delete();
	return error === null ? data : domainOutcome(error.value, "History catch-up could not be cancelled.");
}

export async function saveMemoryAllowance(conversationId: number, expectedRevision: number, allowance: number) {
	const { data, error } = await conversation(conversationId)["memory-allowance"].post({ expectedRevision, allowance });
	return error === null ? data : domainOutcome(error.value, "Memory Allowance could not be saved.");
}

export type { ConversationMemories, ConversationMemoryAllowance, MemoryCatchup };
