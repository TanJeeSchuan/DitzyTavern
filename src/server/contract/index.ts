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
import { createSemanticTriggerSettingsRoutes } from "./semantic-trigger-settings";
import { createBoxDecisionSettingsRoutes } from "./box-decision-settings";
import { createBoxWindowRoutes } from "./box-window";
import { createBoxRoutes } from "./boxes";
import { healthResponse, workspaceResponse } from "../../shared/contract/workspace";
import { createUpdateChecker, type UpdateChecker } from "../updates";
import { createUpdateRoutes } from "./updates";
import { contentValidators } from "./content-validators";
import { createChangeRoutes } from "./changes";
import { createAuthoring } from "../authoring";
import { loadChatVersions } from "../box/registry";

const chatPath = /^\/api\/conversations\/(\d+)(?:\/|$)/;

export { createChatImportRoutes } from "./chat-import";
export { createCharacterLibraryRoutes } from "./character-library";
export { createConnectionSettingsRoutes } from "./connection-settings";
export { createConversationRoutes } from "./conversation";
export { createNativeConversationRoutes } from "./native-conversation";
export { createPromptPresetRoutes } from "./prompt-preset-routes";
export { createLorebookRoutes } from "./lorebook-routes";
export { createLorebookAttachmentRoutes } from "./lorebook-routes";
export { createSemanticTriggerSettingsRoutes } from "./semantic-trigger-settings";

export const createContract = (database: Database, options: ConversationRouteOptions = {}, artifactDirectory = defaultArtifactDirectory(), updates: UpdateChecker = createUpdateChecker(database), authoring = createAuthoring(database)) => new Elysia()
	// @approved
	//  Every Chat route resolves the Chat's Boxes at the versions it pins, so
	// those versions load before the route runs. A version that fails to load
	// is logged, and the Chat's lookups of that Box fail where they happen.
	.onRequest(async ({ request }) => {
		const chat = chatPath.exec(new URL(request.url).pathname)?.[1];
		if (chat !== undefined) await loadChatVersions(database, Number(chat)).catch((error: unknown) => console.error(`[boxes] Chat ${chat}'s Box versions did not load:`, error));
	})
	.use(contentValidators)
	.get("/api/health", () => ({ ok: true }), { response: healthResponse })
	.get("/api/workspace", () => getWorkspace(database), { response: workspaceResponse })
	.use(createUpdateRoutes(updates))
	.use(createChangeRoutes(database))
	.use(createCharacterLibraryRoutes(database))
	.use(createImageRoutes(database))
	.use(createNativeConversationRoutes(database))
	.use(createConversationRoutes(database, options))
	.use(createPromptPresetRoutes(database))
	.use(createLorebookRoutes(database, options))
	.use(createSemanticTriggerSettingsRoutes(database))
	.use(createBoxDecisionSettingsRoutes(database))
	.use(createBoxWindowRoutes(database))
	.use(createBoxRoutes(database))
	.use(authoring.routes)
	.use(createChatImportRoutes(database, artifactDirectory))
	.use(createConnectionSettingsRoutes(database, options));

export type Contract = ReturnType<typeof createContract>;
