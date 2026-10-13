import { api } from "./lib/eden";
import { requestData, requestOutcome } from "./lib/request-outcome";
import {
	conversationMemoryAllowance,
	conversationMemoryAllowanceApplied,
	conversationMemories,
	memoryAllowanceCommandErrors,
	memoryLabelsCommandErrors,
	memoryLabelsMerged,
	memorySources,
	type ConversationMemories,
	type ConversationMemoryAllowance,
	type MemoryIdentityCommand,
	type MemoryLabelMergeCommand,
	type MemorySources,
} from "./box-windows/registry";

const conversation = (conversationId: number) => api.api.conversations({ id: String(conversationId) });

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

export async function loadMemoryAllowance(conversationId: number, signal?: AbortSignal): Promise<ConversationMemoryAllowance> {
	return requestData(conversation(conversationId)["memory-allowance"].get({ fetch: { signal } }), conversationMemoryAllowance);
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

export async function loadMemorySources(conversationId: number, sources: MemorySources, signal?: AbortSignal): Promise<MemorySources> {
	const query = { messageIds: sources.messageIds.join(","), variantIds: sources.variantIds.join(",") };
	return requestData(conversation(conversationId).memories.sources.get({ query, fetch: { signal } }), memorySources);
}

export type { ConversationMemories, ConversationMemoryAllowance };
