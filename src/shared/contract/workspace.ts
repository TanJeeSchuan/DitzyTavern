import { Type } from "@sinclair/typebox";

// Workspace-level transport schemas: the health probe and the active-chat
// overview returned by the server root.

export const healthResponse = Type.Object({ ok: Type.Boolean() });

export const chatSummary = Type.Object({
	id: Type.Integer(),
	name: Type.String(),
	creationTime: Type.String(),
	lastMessageTime: Type.String(),
});

export const characterSummary = Type.Object({
	id: Type.Integer(),
	name: Type.String(),
});

export const workspaceResponse = Type.Object({
	activeChatId: Type.Union([Type.Null(), Type.Integer()]),
	chats: Type.Array(chatSummary),
	characters: Type.Array(characterSummary),
});
