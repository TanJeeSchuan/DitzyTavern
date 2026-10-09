import type { Database } from "bun:sqlite";
import { GenerationRuntimeRegistry } from "../workflows/generation-runtime";
import {
	createGenerationPreviewStore,
	type GenerationPreviewStore,
} from "../workflows/generation-preview";
import { createStagedImportStore, type StagedImportStore } from "../sillytavern/staged";
import type { RunningWork } from "../memory/work";

// @approved
//  One process-local state container per database. Every store that must
// die with the process (or with a test's throwaway database) lives here,
// behind one sweep tick and one dispose path. Domain modules own their
// store behavior; this container owns only lifecycle: creation, expiry
// sweeping, and teardown. The per-database WeakMap prevents in-memory test
// databases with reused integer IDs from sharing state.

const PROCESS_STATE_SWEEP_INTERVAL_MS = 60_000;

export interface ProcessState {
	/** @approved Generation fan-out and replay registry; drain semantics live on the registry. */
	readonly generationRuntimes: GenerationRuntimeRegistry;
	readonly generationPreviews: GenerationPreviewStore;
	/** @approved In-flight memory work by variant id: registration and abort only; no expiry semantics. */
	readonly memoryWork: Map<number, Set<RunningWork>>;
	readonly stagedImports: StagedImportStore;
	/** @approved One tick expiring terminal runtime replay state, preview records, and staged sessions. */
	sweep(now?: number): void;
	/** @approved Drop every process-local store for this database and stop the sweep tick. */
	dispose(): void;
}

const states = new WeakMap<Database, ProcessState>();

/** @approved Resolve the process-owned state container for one database scope. */
export function processStateFor(database: Database): ProcessState {
	const existing = states.get(database);
	if (existing !== undefined) return existing;
	const created = createProcessState(database);
	states.set(database, created);
	return created;
}

const createProcessState = (database: Database): ProcessState => {
	const generationRuntimes = new GenerationRuntimeRegistry();
	const generationPreviews = createGenerationPreviewStore();
	const stagedImports = createStagedImportStore();
	const memoryWork = new Map<number, Set<RunningWork>>();
	let timer: ReturnType<typeof setInterval> | undefined;
	// @approved
	//  The one teardown path. The sweep reaps a container whose
	// database has closed: bun:sqlite exposes no open flag and `inTransaction`
	// throws on the closed handle, so a test that skips dispose() and any
	// close path that skips shutdownApplication cannot keep a timer past one
	// sweep.
	const dispose = (): void => {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
		generationPreviews.dispose();
		stagedImports.dispose();
		memoryWork.clear();
		states.delete(database);
	};
	const sweep = (now: number = Date.now()): void => {
		try { void database.inTransaction; } catch { dispose(); return; }
		generationRuntimes.cleanup(now);
		generationPreviews.sweep(now);
		stagedImports.sweep(now);
	};
	// @approved
	// Unref'd: the sweep must never keep a process (or a test run) alive.
	timer = setInterval(() => sweep(), PROCESS_STATE_SWEEP_INTERVAL_MS);
	timer.unref();
	return {
		generationRuntimes,
		generationPreviews,
		memoryWork,
		stagedImports,
		sweep,
		dispose,
	};
};
