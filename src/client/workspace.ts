import { api } from "./lib/eden";
import { formatTimestamp } from "./lib/format";

export type ThemePreference = "system" | "daylight" | "evening";

export type Swipe = {
	id: string;
	text: string;
};

export type WriterMessage = {
	id: string;
	type: "writer";
	authorId: string;
	text: string;
	createdAt: string;
};

export type GeneratedMessage = {
	id: string;
	type: "generated";
	authorId: string;
	createdAt: string;
	activeSwipe: number;
	swipes: Swipe[];
	generation: {
		profile: string;
		model: string;
		prompt: string;
	};
};

export type StoryMessage = WriterMessage | GeneratedMessage;

export type ChatSummary = {
	id: string;
	title: string;
	updatedAt: string;
};

export type Workspace = {
	activeChat: ChatSummary | null;
	chats: ChatSummary[];
	characters: { id: number; name: string }[];
	messages: StoryMessage[];
};

export interface WorkspaceClient {
	loadActiveWorkspace(): Promise<Workspace>;
}

export const workspaceClient: WorkspaceClient = {
	async loadActiveWorkspace() {
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
			activeChat:
				chats.find((chat) => chat.id === String(data.activeChatId)) ?? null,
			chats,
			characters: data.characters.map((character) => ({ ...character })),
			messages: [],
		};
	},
};
