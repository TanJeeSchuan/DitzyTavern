import { api } from "./lib/eden";
import { formatTimestamp } from "./lib/format";

export type ThemePreference = "system" | "daylight" | "evening";

export type ChatSummary = {
	id: string;
	title: string;
	updatedAt: string;
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

export const workspaceClient: WorkspaceClient = {
	async loadActiveWorkspace(preferredChatId?: string) {
		const { data, error } = await api.api.workspace.get();
		if (error || !data) {
			throw new Error("Unable to load workspace");
		}

		const chats = data.chats.map((chat) => ({
			id: String(chat.id),
			title: chat.name,
			updatedAt: formatTimestamp(chat.lastMessageTime),
		}));

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
