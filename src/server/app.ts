import type { Database } from "bun:sqlite";
import { staticPlugin } from "@elysiajs/static";
import { createContract } from "./contract";
import type { ConversationRouteOptions } from "./contract/conversation";
import { defaultArtifactDirectory } from "./artifact";
import { shutdownApplication } from "./application/shutdown";
import { sweepOrphanedImages } from "./image";
import { recoverActiveGenerations } from "./workflows/generation-recovery";
import { embedMemoryTexts, extractAndJudgeMemorySource, startMemoryWorker } from "./memory";
import { createUpdateChecker, type UpdateCheckerOptions } from "./updates";

export interface AppOptions extends ConversationRouteOptions {
	database: Database;
	artifactDirectory?: string;
	updates?: UpdateCheckerOptions;
}

export async function createApp(options: AppOptions) {
	const { database, fetch, artifactDirectory = defaultArtifactDirectory() } = options;
	sweepOrphanedImages(database);
	const stopMemoryWorker = startMemoryWorker(database, {
		process: (source, context, signal, trace) => extractAndJudgeMemorySource(database, source, context, fetch, signal, trace),
		embed: embedMemoryTexts(database, fetch),
	});
	// ==[HUMAN APPROVED]== One process-start sweep resolves only abandoned local Active Generations;
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
		shutdownApplication(database, async () => { await updates.stop(); await stopHttp(); }, stopMemoryWorker);
	return { app, close };
}

function reportRecovery(phase: string, recovery: { failed: number }) {
	if (recovery.failed > 0) {
		console.error(`[generation-recovery] ${phase} recovery left ${recovery.failed} generation(s) unresolved.`);
	}
}
