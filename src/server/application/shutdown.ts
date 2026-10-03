import type { Database } from "bun:sqlite";
import { clearGenerationPreviewRegistry } from "../workflows/generation-preview";
import { gracefullyShutdownGenerations } from "../workflows/generation-recovery";

export async function shutdownApplication(
	database: Database,
	stopHttp: () => Promise<void>,
	stopMemoryWorker: () => Promise<void>,
): Promise<void> {
	const deadline = setTimeout(() => {
		console.error("[shutdown] Work did not finish within five seconds; terminating the process.");
		process.exit(1);
	}, 5_000);
	try {
		const [recovery] = await Promise.all([
			gracefullyShutdownGenerations(database),
			stopHttp(),
			stopMemoryWorker(),
		]);
		if (recovery.failed > 0) console.error(`[generation-recovery] Shutdown recovery left ${recovery.failed} generation(s) unresolved.`);
		clearGenerationPreviewRegistry(database);
		database.close();
	} catch (error) {
		console.error("[shutdown] Could not finish shutdown.", error);
		process.exit(1);
	} finally {
		clearTimeout(deadline);
	}
}
