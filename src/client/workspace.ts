import { applyConversationCommand, type ConversationSummary } from "./conversation";
import { api } from "./lib/eden";
import { requestData } from "./lib/request-outcome";
import type { Portrait } from "../shared/contract/image";
import { workspaceResponse } from "../shared/contract/workspace";

export type ThemePreference = "system" | "daylight" | "evening";
export type SwipeBrowsing = "fan" | "modal";

export type ChatSummary = {
	id: string;
	title: string;
	revision: number;
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
	const data = await requestData(api.api.workspace.get(), workspaceResponse);
	return {
		...data,
		chats: data.chats.map((chat): ChatSummary => ({
			id: String(chat.id),
			title: chat.name,
			revision: chat.revision,
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

// @approved
//  Renames any Chat, not only the open one, at the revision its list row
// carries; a revision that moved since the list was read is retried once.
export async function renameChat(chat: Pick<ChatSummary, "id" | "revision">, name: string): Promise<{ outcome: "renamed"; conversation: ConversationSummary } | { outcome: "failed"; reason: string }> {
	const id = Number(chat.id);
	let outcome = await applyConversationCommand(id, chat.revision, { type: "rename-conversation", name });
	if (outcome.outcome === "conflict") outcome = await applyConversationCommand(id, outcome.currentConversation.revision, { type: "rename-conversation", name });
	if (outcome.outcome === "available") return { outcome: "renamed", conversation: outcome.value.conversation };
	return { outcome: "failed", reason: outcome.outcome === "invalid" || outcome.outcome === "unusable" ? outcome.reason : "The Chat could not be renamed." };
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
