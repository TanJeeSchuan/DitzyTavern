import type { Database } from "bun:sqlite";
import { staticPlugin } from "@elysiajs/static";
import { createContract } from "./contract";
import type { ConversationRouteOptions } from "./contract/conversation";
import { defaultArtifactDirectory } from "./artifact";
import { observeConversationWrites } from "./conversation";
import { shutdownApplication } from "./application/shutdown";
import { sweepOrphanedImages } from "./image";
import { recoverActiveGenerations } from "./workflows/generation-recovery";
import { createUpdateChecker, type UpdateCheckerOptions } from "./updates";
import { prepareBoxDigests, startBoxDigests } from "./box/digest";

export interface AppOptions extends ConversationRouteOptions {
	database: Database;
	artifactDirectory?: string;
	updates?: UpdateCheckerOptions;
}

export async function createApp(options: AppOptions) {
	const { database, fetch, artifactDirectory = defaultArtifactDirectory() } = options;
	// @approved
	//  The application layer consumes Conversation's reported changes: Box
	// digest changes are prepared inside the Conversation transaction
	// and published synchronously after it commits.
	observeConversationWrites(database, prepareBoxDigests);
	const stopBoxDigests = startBoxDigests(database, { fetch });
	sweepOrphanedImages(database);
	// @approved
	//  One process-start sweep resolves only abandoned local Active Generations;
	// it never resumes or retries a provider request.
	reportRecovery("Startup", recoverActiveGenerations(database));

	const serveIndex = () => Bun.file("dist/index.html");
	const updates = createUpdateChecker(database, options.updates);
	// @approved
	//  Hashed assets are cached for a day. The host chunks keep their names
	// across builds, as Box client modules do, so a browser revalidates them
	// rather than run a stale one against a newer host. The Box routes serve
	// the Box client modules.
	const app = createContract(database, options, artifactDirectory, updates)
		.get("/", serveIndex)
		.use(await staticPlugin({ assets: "dist", prefix: "/", indexHTML: true, alwaysStatic: true, ignorePatterns: [/[\\/]dist[\\/](?:host|boxes)[\\/]/] }))
		.use(await staticPlugin({ assets: "dist/host", prefix: "/host", alwaysStatic: true, directive: "no-cache", maxAge: null }))
		.onError(({ code, path }) => {
			if (code === "NOT_FOUND" && !path.startsWith("/api/")) return serveIndex();
		});
	updates.start();

	const close = (stopHttp: () => Promise<void> = async () => {}) =>
		shutdownApplication(database, async () => { await updates.stop(); await stopHttp(); }, stopBoxDigests);
	return { app, close };
}

function reportRecovery(phase: string, recovery: { failed: number }) {
	if (recovery.failed > 0) {
		console.error(`[generation-recovery] ${phase} recovery left ${recovery.failed} generation(s) unresolved.`);
	}
}
