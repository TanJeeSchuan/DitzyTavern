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
import { queueBoxDigests, startBoxDigests } from "./box/digest";

export interface AppOptions extends ConversationRouteOptions {
	database: Database;
	artifactDirectory?: string;
	updates?: UpdateCheckerOptions;
}

export async function createApp(options: AppOptions) {
	const { database, fetch, artifactDirectory = defaultArtifactDirectory() } = options;
	// @approved
	//  The application layer consumes Conversation's reported changes: Box
	// digest queueing runs as the last statement of the Conversation
	// transaction wrapper, so its reads see exactly the committed write.
	observeConversationWrites(database, queueBoxDigests);
	const stopBoxDigests = startBoxDigests(database, { fetch });
	sweepOrphanedImages(database);
	// @approved
	//  One process-start sweep resolves only abandoned local Active Generations;
	// it never resumes or retries a provider request.
	reportRecovery("Startup", recoverActiveGenerations(database));

	const serveIndex = () => Bun.file("dist/index.html");
	const updates = createUpdateChecker(database, options.updates);
	const app = createContract(database, options, artifactDirectory, updates)
		.get("/", serveIndex)
		.use(await staticPlugin({ assets: "dist", prefix: "/", indexHTML: true, alwaysStatic: true }))
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
