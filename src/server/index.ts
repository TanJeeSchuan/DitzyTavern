import { staticPlugin } from "@elysiajs/static";
import { registerWireFormats } from "../shared/contract/wire-formats";
import { createContract } from "./contract";
import { shutdownApplication } from "./application/shutdown";
import { openInitializedDatabase } from "./database/database";
import { initializeConnectionSecretKey } from "./connection-secrets";
import { recoverActiveGenerations } from "./workflows/generation-recovery";
import { extractAndJudgeMemorySource, startMemoryWorker } from "./memory";
import { sweepOrphanedImages } from "./image";

registerWireFormats();
initializeConnectionSecretKey();
const database = openInitializedDatabase();
sweepOrphanedImages(database);
const stopMemoryWorker = startMemoryWorker(database, {
	process: (source, context, signal, trace) => extractAndJudgeMemorySource(database, source, context, undefined, signal, trace),
});
// ==[HUMAN APPROVED]== One process-start sweep resolves only abandoned local Active Generations;
// it never resumes or retries a provider request.
const startupRecovery = recoverActiveGenerations(database);
if (startupRecovery.failed > 0) {
	console.error(
		`[generation-recovery] Startup recovery left ${startupRecovery.failed} ` +
		`generation(s) unresolved.`,
	);
}

const serveIndex = () => Bun.file("dist/index.html");
const staticAssets = await staticPlugin({
	assets: "dist",
	prefix: "/",
	indexHTML: true,
	alwaysStatic: true,
});

const app = createContract(database)
	.get("/", serveIndex)
	.use(staticAssets)
	.onError(({ code, path }) => {
		if (
			code === "NOT_FOUND" &&
			!path.startsWith("/api/") &&
			!path.startsWith("/events")
		) {
			return serveIndex();
		}
	})
	.listen({ hostname: "127.0.0.1", port: 3000 });

const shutdown = () => {
	process.off("SIGINT", shutdown);
	process.off("SIGTERM", shutdown);
	void shutdownApplication(database, async () => { await app.stop(); }, stopMemoryWorker);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(`DitzyTavern server listening on ${app.server?.url}`);
