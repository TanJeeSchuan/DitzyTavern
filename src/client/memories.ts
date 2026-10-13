import { api } from "./lib/eden";
import { requestData, requestOutcome } from "./lib/request-outcome";
import {
	conversationMemoryAllowance,
	conversationMemoryAllowanceApplied,
	conversationMemories,
	memoryAllowanceCommandErrors,
	memoryLabelsCommandErrors,
	memoryLabelsMerged,
	type ConversationMemories,
	type ConversationMemoryAllowance,
	type MemoryIdentityCommand,
	type MemoryLabelMergeCommand,
} from "../shared/contract/memory";

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

export type { ConversationMemories, ConversationMemoryAllowance };
