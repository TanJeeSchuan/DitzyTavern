import type { ConversationMemories, ConversationMemoryAllowance, ConversationMemoryChanges, MemoryCatchup, MemoryCorrectionCommand, MemoryIdentityCommand, MemoryLabelMergeCommand, MemorySourceTarget, MemoryTraceStep } from "../shared/contract/memory";
import { api, domainOutcome } from "./lib/eden";

const conversation = (conversationId: number) => api.api.conversations({ id: String(conversationId) });

export async function saveMemoryIdentity(conversationId: number, command: MemoryIdentityCommand) {
	const { data, error } = await conversation(conversationId).memories.identity.post(command);
	return error === null ? data : domainOutcome(error.value, "Memory identity could not be saved.");
}

export async function mergeMemoryLabels(conversationId: number, command: MemoryLabelMergeCommand) {
	const { data, error } = await conversation(conversationId).memories["merge-labels"].post(command);
	return error === null ? data : domainOutcome(error.value, "Labels could not be merged.");
}

export async function loadConversationMemories(conversationId: number, signal?: AbortSignal): Promise<ConversationMemories> {
	const { data, error } = await conversation(conversationId).memories.get({ fetch: { signal } });
	if (error || data === undefined) throw new Error("Memories could not be loaded.");
	return data;
}

export async function loadMemoryChanges(conversationId: number, since: string, signal?: AbortSignal): Promise<ConversationMemoryChanges> {
	const { data, error } = await conversation(conversationId).memories.changes.get({ query: { since }, fetch: { signal } });
	if (error || data === undefined) throw new Error("Memory changes could not be loaded.");
	return data;
}

export async function loadMemoryTrace(conversationId: number, variantId: number): Promise<MemoryTraceStep[]> {
	const { data, error } = await conversation(conversationId).memories({ variantId: String(variantId) }).trace.get();
	if (error || data === undefined) throw new Error("Memory trace could not be loaded.");
	return data.steps;
}

export async function loadMemoryCatchup(conversationId: number, signal?: AbortSignal): Promise<MemoryCatchup | null> {
	const { data, error } = await conversation(conversationId).memories.catchup.get({ fetch: { signal } });
	if (error || data === undefined) throw new Error("History catch-up status could not be loaded.");
	return data.run;
}

export async function loadMemoryAllowance(conversationId: number, signal?: AbortSignal): Promise<ConversationMemoryAllowance> {
	const { data, error } = await conversation(conversationId)["memory-allowance"].get({ fetch: { signal } });
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

export type MemoryCatchupResult = Awaited<ReturnType<typeof startMemoryCatchup | typeof cancelMemoryCatchup>>;

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

export async function saveMemoryNote(conversationId: number, expectedRevision: number, note: string) {
	const { data, error } = await conversation(conversationId)["memory-note"].post({ expectedRevision, note });
	return error === null ? data : domainOutcome(error.value, "The Memory note could not be saved.");
}

export type { ConversationMemories, ConversationMemoryAllowance, ConversationMemoryChanges, MemoryCatchup };
