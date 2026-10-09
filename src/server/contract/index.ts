import type { Database } from "bun:sqlite";
import type { ConversationRouteOptions } from "./conversation";
import { Elysia } from "elysia";
import { defaultArtifactDirectory } from "../artifact";
import { getWorkspace } from "../database/workspace";
import { createChatImportRoutes } from "./chat-import";
import { createCharacterLibraryRoutes } from "./character-library";
import { createConnectionSettingsRoutes } from "./connection-settings";
import { createImageRoutes } from "./image";
import { createConversationRoutes } from "./conversation";
import { createNativeConversationRoutes } from "./native-conversation";
import { createPromptPresetRoutes } from "./prompt-preset-routes";
import { createLorebookRoutes } from "./lorebook-routes";
import { createMemorySettingsRoutes } from "./memory-settings";
import { createSemanticTriggerSettingsRoutes } from "./semantic-trigger-settings";
import { createMemoryRoutes } from "./memory";
import { healthResponse, workspaceResponse } from "../../shared/contract/workspace";
import { createUpdateChecker, type UpdateChecker } from "../updates";
import { createUpdateRoutes } from "./updates";

export { createChatImportRoutes } from "./chat-import";
export { createCharacterLibraryRoutes } from "./character-library";
export { createConnectionSettingsRoutes } from "./connection-settings";
export { createConversationRoutes } from "./conversation";
export { createNativeConversationRoutes } from "./native-conversation";
export { createPromptPresetRoutes } from "./prompt-preset-routes";
export { createLorebookRoutes } from "./lorebook-routes";
export { createLorebookAttachmentRoutes } from "./lorebook-routes";
export { createMemorySettingsRoutes } from "./memory-settings";
export { createSemanticTriggerSettingsRoutes } from "./semantic-trigger-settings";
export { createMemoryRoutes } from "./memory";

export const createContract = (database: Database, options: ConversationRouteOptions = {}, artifactDirectory = defaultArtifactDirectory(),
	updates: UpdateChecker = createUpdateChecker(database)) => new Elysia()
	.get("/api/health", () => ({ ok: true }), { response: healthResponse })
	.get("/api/workspace", () => getWorkspace(database), { response: workspaceResponse })
	.use(createUpdateRoutes(updates))
	.use(createCharacterLibraryRoutes(database))
	.use(createImageRoutes(database))
	.use(createNativeConversationRoutes(database))
	.use(createConversationRoutes(database, options))
	.use(createPromptPresetRoutes(database))
	.use(createLorebookRoutes(database, options))
	.use(createMemorySettingsRoutes(database))
	.use(createSemanticTriggerSettingsRoutes(database))
	.use(createMemoryRoutes(database))
	.use(createChatImportRoutes(database, artifactDirectory))
	.use(createConnectionSettingsRoutes(database, options));

export type Contract = ReturnType<typeof createContract>;
