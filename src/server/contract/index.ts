import type { Database } from "bun:sqlite";
import type { ConversationRouteOptions } from "./conversation";
import { Elysia } from "elysia";
import { defaultArtifactDirectory } from "../artifact";
import { getWorkspace } from "../database/workspace";
import { createChatImportRoutes } from "./chat-import";
import { createCharacterLibraryRoutes } from "./character-library";
import { createConnectionSettingsRoutes } from "./connection-settings";
import { createConversationRoutes } from "./conversation";
import { createNativeConversationRoutes } from "./native-conversation";
import { createPromptPresetRoutes } from "./prompt-preset-routes";
import { createLorebookRoutes } from "./lorebook-routes";
import { createEmbeddingSettingsRoutes } from "./embedding-settings";
import { healthResponse, workspaceResponse } from "../../shared/contract/workspace";

export { createChatImportRoutes } from "./chat-import";
export { createCharacterLibraryRoutes } from "./character-library";
export { createConnectionSettingsRoutes } from "./connection-settings";
export { createConversationRoutes } from "./conversation";
export { createNativeConversationRoutes } from "./native-conversation";
export { createPromptPresetRoutes } from "./prompt-preset-routes";
export { createLorebookRoutes } from "./lorebook-routes";
export { createLorebookAttachmentRoutes } from "./lorebook-routes";
export { createEmbeddingSettingsRoutes } from "./embedding-settings";

export const createContract = (database?: Database, options: ConversationRouteOptions = {}, artifactDirectory = defaultArtifactDirectory()) => new Elysia()
	.get("/api/health", () => ({ ok: true }), { response: healthResponse })
	.get("/api/workspace", () => getWorkspace(database), { response: workspaceResponse })
	.use(createCharacterLibraryRoutes(database))
	.use(createNativeConversationRoutes(database))
	.use(createConversationRoutes(database, options))
	.use(createPromptPresetRoutes(database))
	.use(createLorebookRoutes(database, options))
	.use(createEmbeddingSettingsRoutes(database, options))
	.use(createChatImportRoutes(database, artifactDirectory))
	.use(createConnectionSettingsRoutes(database, options));

export const contract = createContract();

export type Contract = typeof contract;
