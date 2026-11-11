import type { Database } from "bun:sqlite";
import { staticPlugin } from "@elysiajs/static";
import { createContract } from "./contract";
import type { ConversationRouteOptions } from "./contract/conversation";
import { defaultArtifactDirectory } from "./artifact";
import { observeConversationWrites, readActiveGenerationsForRecovery } from "./conversation";
import { shutdownApplication } from "./application/shutdown";
import { sweepOrphanedImages } from "./image";
import { recoverActiveGenerations } from "./workflows/generation-recovery";
import { createUpdateChecker, type UpdateCheckerOptions } from "./updates";
import { prepareBoxDigests, startBoxDigests } from "./box/digest";
import { loadChatVersions } from "./box/registry";
import { bootIndex } from "./boot-index";
import { revalidatedText } from "./contract/content-validators";
import { watchDatabaseChanges } from "./database/changes";
import { appPagePolicy } from "../shared/box-frame";
import { createAuthoring, type AuthoringFolders } from "./authoring";

export interface AppOptions extends ConversationRouteOptions {
	database: Database;
	artifactDirectory?: string;
	updates?: UpdateCheckerOptions;
	authoring?: AuthoringFolders;
}

export async function createApp(options: AppOptions) {
	const { database, fetch, artifactDirectory = defaultArtifactDirectory() } = options;
	// @approved
	//  The application layer consumes Conversation's reported changes: Box
	// digest changes are prepared inside the Conversation transaction
	// and published synchronously after it commits.
	observeConversationWrites(database, prepareBoxDigests);
	const stopBoxDigests = startBoxDigests(database, { fetch });
	const stopChanges = watchDatabaseChanges(database);
	// @approved
	//  One process-start sweep resolves only abandoned local Active Generations;
	// it never resumes or retries a provider request. It runs before the Image
	// sweep so recovered output is whole Variant text when the sweep reads it:
	// a Reference can straddle two checkpoint deltas.
	// @approved
	// Recovery settles Chats through their summaries, which read each Box at the version its Chat pins.
	for (const conversationId of new Set(readActiveGenerationsForRecovery(database).map((row) => row.conversationId))) {
		await loadChatVersions(database, conversationId).catch((error: Error) => console.error(`[boxes] Chat ${conversationId}'s Box versions did not load:`, error));
	}
	reportRecovery("Startup", recoverActiveGenerations(database));
	sweepOrphanedImages(database);

	const serveIndex = async (request: Request) => revalidatedText(request, await bootIndex(database), {
		"content-type": "text/html;charset=utf-8",
		"content-security-policy": appPagePolicy(request.headers.get("host") ?? new URL(request.url).host),
	});
	const updates = createUpdateChecker(database, options.updates);
	const authoring = createAuthoring(database, options.authoring);
	await authoring.sweep();
	// @approved
	//  Hashed assets are immutable: a new build gives them new names. The host
	// chunks keep their names across builds, as Box client modules do, so a
	// browser revalidates them rather than run a stale one against a newer
	// host. The Box routes serve the Box client modules.
	const app = createContract(database, options, artifactDirectory, updates, authoring)
		.get("/", ({ request }) => serveIndex(request))
		.use(await staticPlugin({ assets: "dist", prefix: "/", indexHTML: true, alwaysStatic: true, ignorePatterns: [/[\\/]dist[\\/](?:assets|host|boxes)[\\/]/] }))
		.use(await staticPlugin({ assets: "dist/assets", prefix: "/assets", alwaysStatic: true, directive: "immutable", maxAge: 31536000 }))
		.use(await staticPlugin({ assets: "dist/host", prefix: "/host", alwaysStatic: true, directive: "no-cache", maxAge: null }))
		.onError(({ code, path, request }) => {
			if (code === "NOT_FOUND" && !path.startsWith("/api/") && !/\.\w+$/.test(path)) return serveIndex(request);
		});
	updates.start();

	let closing: Promise<void> | undefined;
	const close = (stopHttp: () => Promise<void> = async () => {}) =>
		closing ??= shutdownApplication(database, async () => { stopChanges(); await Promise.all([updates.stop(), authoring.close()]); await stopHttp(); }, stopBoxDigests);
	return { app, close };
}

function reportRecovery(phase: string, recovery: { failed: number }) {
	if (recovery.failed > 0) {
		console.error(`[generation-recovery] ${phase} recovery left ${recovery.failed} generation(s) unresolved.`);
	}
}
