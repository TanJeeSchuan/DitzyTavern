import { Elysia, t } from "elysia";
import { defaultArtifactDirectory } from "../server/artifact";
import { getWorkspace } from "../server/database/workspace";
import { createCharacterLibraryRoutes } from "./contract/character-library";
import {
	createConversationRoutes,
} from "./contract/conversation";
import { createNativeConversationRoutes } from "./contract/native-conversation";
import { createChatImportRoutes } from "./contract/chat-import";
import { createConnectionSettingsRoutes } from "./contract/connection-settings";

export { createCharacterLibraryRoutes } from "./contract/character-library";
export {
	createConversationRoutes,
} from "./contract/conversation";
export { createNativeConversationRoutes } from "./contract/native-conversation";
export { createChatImportRoutes } from "./contract/chat-import";
export { createConnectionSettingsRoutes } from "./contract/connection-settings";

const chatSummary = t.Object({
	id: t.Integer(),
	name: t.String(),
	creationTime: t.String(),
	lastMessageTime: t.String(),
});

const characterSummary = t.Object({
	id: t.Integer(),
	name: t.String(),
});

export const contract = new Elysia()
	.get("/api/health", () => ({ ok: true }), {
		response: t.Object({ ok: t.Boolean() }),
	})
	.get("/api/workspace", () => getWorkspace(), {
		response: t.Object({
			activeChatId: t.Nullable(t.Integer()),
			chats: t.Array(chatSummary),
			characters: t.Array(characterSummary),
		}),
	})
	.use(createCharacterLibraryRoutes(undefined))
	.use(createNativeConversationRoutes(undefined))
	.use(createConversationRoutes(undefined))
	.use(createChatImportRoutes(undefined, defaultArtifactDirectory()))
	.use(createConnectionSettingsRoutes(undefined));

export type Contract = typeof contract;
