import { api } from "./lib/eden";

export type ThemePreference = "system" | "daylight" | "evening";

export type Identity = {
	id: string;
	name: string;
	kind: "writer" | "character";
	portraitUrl?: string;
	ambience: string;
};

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
	castIds: string[];
};

export type Workspace = {
	activeChat: ChatSummary | null;
	chats: ChatSummary[];
	identities: Identity[];
	messages: StoryMessage[];
};

export interface WorkspaceClient {
	loadActiveWorkspace(): Promise<Workspace>;
}

const characterIdentityId = (id: number) => `character:${id}`;

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
			castIds: chat.characterIds.map(characterIdentityId),
		}));
		const identities: Identity[] = [
			{
				id: "writer",
				name: "Writer",
				kind: "writer",
				ambience: "coral",
			},
			...data.characters.map((character) => ({
				id: characterIdentityId(character.id),
				name: character.name,
				kind: "character" as const,
				ambience: "coral",
			})),
		];

		return {
			activeChat:
				chats.find((chat) => chat.id === String(data.activeChatId)) ?? null,
			chats,
			identities,
			messages: [],
		};
	},
};
