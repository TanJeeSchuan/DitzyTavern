import type { Database } from "bun:sqlite";
import { processStateFor } from "../application/process-state";

export interface RunningWork { readonly controller: AbortController; readonly indexSpaceKey: string | null }

// ==[HUMAN APPROVED]== In-flight memory work lives in the process-state container per database;
// registration and abort semantics are unchanged. No expiry: work unregisters itself.
const running = (database: Database) => processStateFor(database).memoryWork;

export const registerMemoryWork = (database: Database, variantId: number, indexSpaceKey: string | null = null) => {
	const work: RunningWork = { controller: new AbortController(), indexSpaceKey };
	const byVariant = running(database);
	const entries = byVariant.get(variantId) ?? new Set<RunningWork>();
	byVariant.set(variantId, entries.add(work));
	return { signal: work.controller.signal, unregister: () => { entries.delete(work); if (entries.size === 0) byVariant.delete(variantId); } };
};

export const abortMemoryWork = (database: Database, variantIds: Iterable<number>): void => {
	const byVariant = running(database);
	for (const variantId of variantIds) for (const work of byVariant.get(variantId) ?? []) work.controller.abort();
};

export const indexingVariants = (database: Database, spaceKey: string): Set<number> =>
	new Set([...running(database)].filter(([, entries]) => [...entries].some((work) => work.indexSpaceKey === spaceKey)).map(([variantId]) => variantId));

export const registeredMemoryVariants = (database: Database): number[] => [...running(database).keys()];
