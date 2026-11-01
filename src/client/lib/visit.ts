import { useEffect, useMemo } from "react";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * @approved
 * The signal of the current visit to `key`: it aborts when `key` changes or the component unmounts.
 * StrictMode remounts in the same task, so the abort waits a microtask and spares a visit that mounted again.
 */
export function useVisitSignal(key?: string | number | null): AbortSignal {
	const visit = useMemo(() => ({ controller: new AbortController(), mounts: 0 }), [key]);
	useEffect(() => {
		visit.mounts += 1;
		return () => {
			visit.mounts -= 1;
			queueMicrotask(() => { if (visit.mounts === 0) visit.controller.abort(); });
		};
	}, [visit]);
	return visit.controller.signal;
}

/** @approved Writes an authoritative copy into the cache unless the cached copy has a newer revision, and drops in-flight reads of it. */
export const foldNewer = <T>(client: QueryClient, queryKey: QueryKey, value: T, revisionOf: (value: T) => number) => {
	void client.cancelQueries({ queryKey });
	return client.setQueryData<T>(queryKey, (current) => current !== undefined && revisionOf(current) > revisionOf(value) ? current : value);
};
