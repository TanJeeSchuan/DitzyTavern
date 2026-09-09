import { Elysia } from "elysia";
import { defaultArtifactDirectory } from "../artifact";
import { getWorkspace } from "../database/workspace";
import { createChatImportRoutes } from "./chat-import";
import { createCharacterLibraryRoutes } from "./character-library";
import { createConnectionSettingsRoutes } from "./connection-settings";
import { createConversationRoutes } from "./conversation";
import { createNativeConversationRoutes } from "./native-conversation";
import { createPromptPresetLibraryRoutes } from "./prompt-preset-routes";
import { createPromptPresetRecipeRoutes } from "./prompt-preset";
import { healthResponse, workspaceResponse } from "../../shared/contract/workspace";

export { createChatImportRoutes } from "./chat-import";
export { createCharacterLibraryRoutes } from "./character-library";
export { createConnectionSettingsRoutes } from "./connection-settings";
export { createConversationRoutes } from "./conversation";
export { createNativeConversationRoutes } from "./native-conversation";
export { createPromptPresetLibraryRoutes } from "./prompt-preset-routes";
export { createPromptPresetRecipeRoutes } from "./prompt-preset";

export const contract = new Elysia()
	.get("/api/health", () => ({ ok: true }), { response: healthResponse })
	.get("/api/workspace", () => getWorkspace(), { response: workspaceResponse })
	.use(createCharacterLibraryRoutes(undefined))
	.use(createNativeConversationRoutes(undefined))
	.use(createConversationRoutes(undefined))
	.use(createPromptPresetLibraryRoutes(undefined))
	.use(createChatImportRoutes(undefined, defaultArtifactDirectory()))
	.use(createConnectionSettingsRoutes(undefined))
	.use(createPromptPresetRecipeRoutes(undefined));

export type Contract = typeof contract;
