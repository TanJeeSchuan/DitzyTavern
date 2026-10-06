import { applyConversationCommand, loadConversation, type ConversationSummary } from "./conversation";
import { api } from "./lib/eden";
import type { Portrait } from "../shared/contract/image";

export type ThemePreference = "system" | "daylight" | "evening";

export type ChatSummary = {
	id: string;
	title: string;
	updatedAt: string;
	cast: { name: string; portrait: Portrait | null }[];
	excerpt: string;
};

export type Workspace = {
	activeChat: ChatSummary | null;
	chats: ChatSummary[];
	characters: { id: number; name: string }[];
};

export interface WorkspaceClient {
	loadActiveWorkspace(preferredChatId?: string): Promise<Workspace>;
}

export function resolveWorkspaceActiveChat(
	chats: ChatSummary[],
	authoritativeActiveChatId: string | null,
	preferredChatId?: string,
): ChatSummary | null {
	if (preferredChatId !== undefined) {
		const preferred = chats.find((chat) => chat.id === preferredChatId);
		if (preferred !== undefined) return preferred;
	}
	if (authoritativeActiveChatId === null) return null;
	return chats.find((chat) => chat.id === authoritativeActiveChatId) ?? null;
}

const fetchWorkspace = async () => {
	const { data, error } = await api.api.workspace.get();
	if (error || !data) {
		throw new Error("Unable to load workspace");
	}
	return {
		...data,
		chats: data.chats.map((chat): ChatSummary => ({
			id: String(chat.id),
			title: chat.name,
			updatedAt: chat.lastMessageTime,
			cast: chat.cast,
			excerpt: chat.excerpt,
		})),
	};
};

export const listChats = async () => (await fetchWorkspace()).chats;

export async function deleteChat(chatId: string): Promise<string | null> {
	const { error } = await api.api.conversations({ id: Number(chatId) }).delete();
	if (!error) return null;
	return error.status === 422 && "reason" in error.value ? error.value.reason : "The Chat could not be deleted.";
}

// ==[HUMAN APPROVED]== Renames any Chat, not only the open one, so the current revision is read
// first; a revision that moved in between is retried once.
export async function renameChat(chatId: string, name: string): Promise<{ status: "renamed"; conversation: ConversationSummary } | { status: "failed"; reason: string }> {
	const current = await loadConversation(Number(chatId)).catch(() => null);
	if (current === null) return { status: "failed", reason: "The Chat could not be reached." };
	let outcome = await applyConversationCommand(current.id, current.revision, { type: "rename-conversation", name });
	if (outcome.status === "conflict") outcome = await applyConversationCommand(current.id, outcome.currentConversation.revision, { type: "rename-conversation", name });
	if (outcome.status === "applied") return { status: "renamed", conversation: outcome.conversation };
	return { status: "failed", reason: outcome.status === "invalid" ? outcome.reason : "The Chat could not be renamed." };
}

export const workspaceClient: WorkspaceClient = {
	async loadActiveWorkspace(preferredChatId?: string) {
		const data = await fetchWorkspace();
		const chats = data.chats;

		return {
			activeChat: resolveWorkspaceActiveChat(
				chats,
				data.activeChatId === null ? null : String(data.activeChatId),
				preferredChatId,
			),
			chats,
			characters: data.characters.map((character) => ({ ...character })),
		};
	},
};
