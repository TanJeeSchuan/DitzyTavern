import type { ConversationMemories, ConversationMemoryAllowance } from "../shared/contract/memory";
import { Value } from "@sinclair/typebox/value";
import { memoryInvalid, conversationMemoryAllowanceConflict } from "../shared/contract/memory";
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
