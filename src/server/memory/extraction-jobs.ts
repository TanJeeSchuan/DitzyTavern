import type { Database } from "bun:sqlite";

const activeByDatabase = new WeakMap<Database, Map<number, Set<AbortController>>>();

export const registerMemoryExtractionController = (database: Database, variantId: number, controller: AbortController): (() => void) => {
	let byVariant = activeByDatabase.get(database);
	if (!byVariant) {
		byVariant = new Map();
		activeByDatabase.set(database, byVariant);
	}
	const jobs = byVariant.get(variantId) ?? new Set<AbortController>();
	jobs.add(controller);
	byVariant.set(variantId, jobs);
	return () => {
		jobs.delete(controller);
		if (jobs.size === 0) byVariant.delete(variantId);
	};
};

export const cancelMemoryExtractionWork = (database: Database, variantId: number): void => {
	for (const controller of activeByDatabase.get(database)?.get(variantId) ?? []) controller.abort();
};
