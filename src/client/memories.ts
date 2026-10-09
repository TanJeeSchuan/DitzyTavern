import { api } from "./lib/eden";
import { requestData, requestOutcome } from "./lib/request-outcome";
import {
	conversationMemoryAllowance,
	conversationMemoryAllowanceApplied,
	conversationMemories,
	conversationMemoryChanges,
	memoryAllowanceCommandErrors,
	memoryCatchupCancelled,
	memoryCatchupQueued,
	memoryCatchupCommandErrors,
	memoryCatchupRead,
	memoryCollectionCommandErrors,
	memoryCorrectionApplied,
	memoryLabelsCommandErrors,
	memoryLabelsMerged,
	memoryQueued,
	memoryTrace,
	type ConversationMemories,
	type ConversationMemoryAllowance,
	type ConversationMemoryChanges,
	type MemoryCatchup,
	type MemoryCorrectionCommand,
	type MemoryIdentityCommand,
	type MemoryLabelMergeCommand,
	type MemorySourceTarget,
	type MemoryTraceStep,
} from "../shared/contract/memory";

const conversation = (conversationId: number) => api.api.conversations({ id: String(conversationId) });

export type MemoryCatchupResult = Awaited<ReturnType<typeof startMemoryCatchup | typeof cancelMemoryCatchup>>;

export async function saveMemoryIdentity(conversationId: number, command: MemoryIdentityCommand) {
	return requestOutcome(
		conversation(conversationId).memories.identity.post(command),
		memoryLabelsMerged,
		memoryLabelsCommandErrors,
	);
}

export async function mergeMemoryLabels(conversationId: number, command: MemoryLabelMergeCommand) {
	return requestOutcome(
		conversation(conversationId).memories["merge-labels"].post(command),
		memoryLabelsMerged,
		memoryLabelsCommandErrors,
	);
}

export async function loadConversationMemories(conversationId: number, signal?: AbortSignal): Promise<ConversationMemories> {
	return requestData(conversation(conversationId).memories.get({ fetch: { signal } }), conversationMemories);
}

export async function loadMemoryChanges(conversationId: number, since: string, signal?: AbortSignal): Promise<ConversationMemoryChanges> {
	return requestData(
		conversation(conversationId).memories.changes.get({ query: { since }, fetch: { signal } }),
		conversationMemoryChanges,
	);
}

export async function loadMemoryTrace(conversationId: number, variantId: number): Promise<MemoryTraceStep[]> {
	const trace = await requestData(conversation(conversationId).memories({ variantId: String(variantId) }).trace.get(), memoryTrace);
	return trace.steps;
}

export async function loadMemoryCatchup(conversationId: number, signal?: AbortSignal): Promise<MemoryCatchup | null> {
	const read = await requestData(conversation(conversationId).memories.catchup.get({ fetch: { signal } }), memoryCatchupRead);
	return read.run;
}

export async function loadMemoryAllowance(conversationId: number, signal?: AbortSignal): Promise<ConversationMemoryAllowance> {
	return requestData(conversation(conversationId)["memory-allowance"].get({ fetch: { signal } }), conversationMemoryAllowance);
}

export async function resetAndReextract(conversationId: number, target: MemorySourceTarget) {
	return requestOutcome(
		conversation(conversationId).memories.reextract.post(target),
		memoryQueued,
		memoryCollectionCommandErrors,
	);
}

export async function correctMemory(conversationId: number, command: MemoryCorrectionCommand) {
	return requestOutcome(
		conversation(conversationId).memories.correct.post(command),
		memoryCorrectionApplied,
		memoryCollectionCommandErrors,
	);
}

export async function retryMemoryIndex(conversationId: number, target: MemorySourceTarget) {
	return requestOutcome(
		conversation(conversationId).memories.indexing.retry.post(target),
		memoryQueued,
		memoryCollectionCommandErrors,
	);
}

export async function startMemoryCatchup(conversationId: number) {
	return requestOutcome(
		conversation(conversationId).memories.catchup.post({}),
		memoryCatchupQueued,
		memoryCatchupCommandErrors,
	);
}

export async function cancelMemoryCatchup(conversationId: number, runId: number) {
	return requestOutcome(
		conversation(conversationId).memories.catchup({ runId: String(runId) }).delete(),
		memoryCatchupCancelled,
		memoryCatchupCommandErrors,
	);
}

export async function saveMemoryAllowance(conversationId: number, expectedRevision: number, allowance: number) {
	return requestOutcome(
		conversation(conversationId)["memory-allowance"].post({ expectedRevision, allowance }),
		conversationMemoryAllowanceApplied,
		memoryAllowanceCommandErrors,
	);
}

export async function saveMemoryNote(conversationId: number, expectedRevision: number, note: string) {
	return requestOutcome(
		conversation(conversationId)["memory-note"].post({ expectedRevision, note }),
		conversationMemoryAllowanceApplied,
		memoryAllowanceCommandErrors,
	);
}

export type { ConversationMemories, ConversationMemoryAllowance, ConversationMemoryChanges, MemoryCatchup };
export type { MemoryTraceStep };
