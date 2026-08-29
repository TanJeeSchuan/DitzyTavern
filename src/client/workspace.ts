import { api } from "./lib/eden";

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
	loadActiveWorkspace(): Promise<Workspace>;
}

const formatUpdatedAt = (value: string) => {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return value;
	}

	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(date);
};

export const workspaceClient: WorkspaceClient = {
	async loadActiveWorkspace() {
		const { data, error } = await api.api.workspace.get();
		if (error || !data) {
			throw new Error("Unable to load workspace");
		}

		const chats = data.chats.map((chat) => ({
			id: String(chat.id),
			title: chat.name,
			updatedAt: formatUpdatedAt(chat.lastMessageTime),
		}));

		return {
			activeChat:
				chats.find((chat) => chat.id === String(data.activeChatId)) ?? null,
			chats,
			characters: data.characters.map((character) => ({ ...character })),
		};
	},
};
