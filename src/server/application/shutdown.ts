import type { Database } from "bun:sqlite";
import { processStateFor } from "./process-state";
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
		// ==[HUMAN APPROVED]== One dispose path drops every process-local store for this database:
		// inspection previews, staged import sessions (the restart contract),
		// in-flight memory work, and the sweep tick.
		processStateFor(database).dispose();
		database.close();
	} catch (error) {
		console.error("[shutdown] Could not finish shutdown.", error);
		process.exit(1);
	} finally {
		clearTimeout(deadline);
	}
}
