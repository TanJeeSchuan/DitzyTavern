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
	activeChat: ChatSummary;
	chats: ChatSummary[];
	identities: Identity[];
	messages: StoryMessage[];
};

export type MockReply = {
	writerMessage: WriterMessage;
	generatedMessage: GeneratedMessage;
};

export interface WorkspaceClient {
	loadActiveWorkspace(): Promise<Workspace>;
	createMockReply(identity: Identity, text: string): Promise<MockReply>;
}

const identities: Identity[] = [
	{
		id: "writer",
		name: "Writer",
		kind: "writer",
		ambience: "coral",
	},
	{
		id: "maren",
		name: "Maren Voss",
		kind: "character",
		portraitUrl: "https://picsum.photos/seed/maren-voss-portrait/320/320",
		ambience: "ember",
	},
	{
		id: "juno",
		name: "Juno Ashfeld",
		kind: "character",
		portraitUrl: "https://picsum.photos/seed/juno-ashfeld-portrait/320/320",
		ambience: "sage",
	},
	{
		id: "orin",
		name: "Orin Vale",
		kind: "character",
		portraitUrl: "https://picsum.photos/seed/orin-vale-portrait/320/320",
		ambience: "slate",
	},
];

const chats: ChatSummary[] = [
	{
		id: "lantern-house",
		title: "The Lantern House",
		updatedAt: "Today, 21:04",
		castIds: ["maren", "juno", "orin"],
	},
	{
		id: "salt-and-ember",
		title: "Salt and Ember",
		updatedAt: "Yesterday",
		castIds: ["maren", "orin"],
	},
	{
		id: "cartographers-daughter",
		title: "The Cartographer's Daughter",
		updatedAt: "15 Aug",
		castIds: ["juno", "orin"],
	},
];

const messages: StoryMessage[] = [
	{
		id: "direction-1",
		type: "writer",
		authorId: "writer",
		createdAt: "20:41",
		text: "Let Maren notice the light in the upstairs window. Keep the reunion restrained, as if both of them are afraid to name what changed.",
	},
	{
		id: "message-1",
		type: "generated",
		authorId: "maren",
		createdAt: "20:42",
		activeSwipe: 0,
		swipes: [
			{
				id: "message-1-a",
				text: "Maren saw the lamp before she saw the house. It burned in the upper window, small and deliberate against the wet blue of evening. Someone had trimmed the wick. Someone had expected the dark.\n\nShe stopped where the lane narrowed between the pear trees. The gate leaned open, just as it had in every memory she trusted least. Beyond it, the Lantern House waited with its roof silvered by rain.",
			},
			{
				id: "message-1-b",
				text: "The upstairs lamp was lit. Maren stood beneath the pear trees and watched it steady itself in the rain, a patient square of amber above the unlatched gate.\n\nShe had imagined this return often enough to make it useless. None of those rehearsals had included the simple fact of someone waiting.",
			},
			{
				id: "message-1-c",
				text: "Rain gathered on Maren's collar while the house held its single light above her. The sight of it loosened something she had kept carefully still for six years.\n\nShe rested one hand on the gate. Inside, a floorboard answered with a quiet creak, then silence.",
			},
		],
		generation: {
			profile: "Patient prose",
			model: "Mock local model",
			prompt: "Continue in close third person. Maren sees the upstairs light. Keep the reunion restrained and avoid resolving the tension.",
		},
	},
	{
		id: "direction-2",
		type: "writer",
		authorId: "writer",
		createdAt: "20:48",
		text: "Juno opens the door before Maren can knock. Give them one ordinary detail to focus on instead of talking about the past.",
	},
	{
		id: "message-2",
		type: "generated",
		authorId: "juno",
		createdAt: "20:49",
		activeSwipe: 1,
		swipes: [
			{
				id: "message-2-a",
				text: "The door opened while Maren's hand was still raised. Juno looked past her first, toward the road, as if checking whether the weather had followed her all this way.\n\n\"Your left boot is untied,\" she said.\n\nMaren lowered her hand. \"It has been for miles.\"",
			},
			{
				id: "message-2-b",
				text: "Before Maren could knock, Juno pulled the door inward. Warm light crossed the step and stopped at Maren's boots. For a moment neither of them moved.\n\nJuno looked down. \"You still lace the left one wrong.\"\n\nMaren followed her gaze, grateful for the offered smallness of it. \"You still notice.\"",
			},
			{
				id: "message-2-c",
				text: "Juno opened the door on Maren's unfinished breath. Her hair was shorter. That was the first fact Maren could manage.\n\n\"The hinge sticks when it rains,\" Juno said, keeping one hand on the door.\n\n\"I remember.\"\n\nIt was not what either of them meant.",
			},
		],
		generation: {
			profile: "Patient prose",
			model: "Mock local model",
			prompt: "Juno opens the door before Maren knocks. Use one mundane observation as a safe subject. Preserve subtext and close third-person narration.",
		},
	},
];

const wait = (duration: number) =>
	new Promise<void>((resolve) => window.setTimeout(resolve, duration));

const cloneWorkspace = (): Workspace =>
	structuredClone({
		activeChat: chats[0],
		chats,
		identities,
		messages,
	});

export const mockWorkspaceClient: WorkspaceClient = {
	async loadActiveWorkspace() {
		await wait(320);
		return cloneWorkspace();
	},

	async createMockReply(identity, text) {
		await wait(760);
		const timestamp = new Date().toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
		});
		const token = Date.now().toString(36);
		const writerMessage: WriterMessage = {
			id: `direction-${token}`,
			type: "writer",
			authorId: identity.id,
			createdAt: timestamp,
			text,
		};
		const respondingCharacter = identities.find(
			(candidate) => candidate.kind === "character",
		)!;
		const generatedMessage: GeneratedMessage = {
			id: `message-${token}`,
			type: "generated",
			authorId: respondingCharacter.id,
			createdAt: timestamp,
			activeSwipe: 0,
			swipes: [
				{
					id: `message-${token}-a`,
					text: "Maren let the quiet settle before she crossed the threshold. The room had changed in careful ways, but the old kettle still waited beside the stove.\n\nShe set her damp gloves on the table. Outside, rain moved softly through the pear trees.",
				},
			],
			generation: {
				profile: "Patient prose",
				model: "Mock local model",
				prompt: text,
			},
		};

		return { writerMessage, generatedMessage };
	},
};

// Replace this export with an Eden-backed implementation when Chat RPCs exist.
export const workspaceClient: WorkspaceClient = mockWorkspaceClient;
