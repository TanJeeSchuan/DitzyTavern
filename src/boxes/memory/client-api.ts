import { boxApi, requestData, requestOutcome } from "@/box-sdk/client";
import {
	conversationMemoryAllowance,
	conversationMemoryAllowanceApplied,
	conversationMemories,
	memoryAllowanceCommandErrors,
	memoryLabelsCommandErrors,
	memoryLabelsMerged,
	memorySettingsApplied,
	memorySettingsCommandErrors,
	memorySettingsResponse,
	memorySources,
	type ConversationMemories,
	type ConversationMemoryAllowance,
	type ConversationMemoryAllowanceCommand,
	type MemoryIdentityCommand,
	type MemoryLabelMergeCommand,
	type MemorySettingsCommand,
	type MemorySettingsPayload,
	type MemorySources,
} from "./contract";
import type { MemoryRoutes } from "./server-routes";

const memory = boxApi<MemoryRoutes>("memory");
const conversation = (conversationId: number) => memory.conversations({ id: String(conversationId) });

export type MemorySettings = MemorySettingsPayload;

export async function loadMemorySettings(): Promise<MemorySettings> {
	return requestData(memory.settings.get(), memorySettingsResponse);
}

export async function saveMemorySettings(command: MemorySettingsCommand) {
	return requestOutcome(memory.settings.commands.post(command), memorySettingsApplied, memorySettingsCommandErrors);
}

export async function saveMemoryIdentity(conversationId: number, command: MemoryIdentityCommand) {
	return requestOutcome(conversation(conversationId).memories.identity.post(command), memoryLabelsMerged, memoryLabelsCommandErrors);
}

export async function mergeMemoryLabels(conversationId: number, command: MemoryLabelMergeCommand) {
	return requestOutcome(conversation(conversationId).memories["merge-labels"].post(command), memoryLabelsMerged, memoryLabelsCommandErrors);
}

export async function loadConversationMemories(conversationId: number, signal?: AbortSignal): Promise<ConversationMemories> {
	return requestData(conversation(conversationId).memories.get({ fetch: { signal } }), conversationMemories);
}

export async function loadMemoryAllowance(conversationId: number, signal?: AbortSignal): Promise<ConversationMemoryAllowance> {
	return requestData(conversation(conversationId).allowance.get({ fetch: { signal } }), conversationMemoryAllowance);
}

export async function saveMemoryAllowance(conversationId: number, command: ConversationMemoryAllowanceCommand) {
	return requestOutcome(conversation(conversationId).allowance.post(command), conversationMemoryAllowanceApplied, memoryAllowanceCommandErrors);
}

export async function saveMemoryNote(conversationId: number, expectedRevision: string, note: string) {
	return requestOutcome(conversation(conversationId).note.post({ expectedRevision, note }), conversationMemoryAllowanceApplied, memoryAllowanceCommandErrors);
}

export async function loadMemorySources(conversationId: number, sources: Pick<MemorySources, "messageIds" | "variantIds">, signal?: AbortSignal): Promise<MemorySources> {
	const query = { messageIds: sources.messageIds.join(","), variantIds: sources.variantIds.join(",") };
	return requestData(conversation(conversationId).memories.sources.get({ query, fetch: { signal } }), memorySources);
}
