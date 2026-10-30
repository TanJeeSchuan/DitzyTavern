import type { Query, QueryClient } from "@tanstack/react-query";

/** @approved A read that names this follows the database: it revalidates on each committed change instead of polling. */
export const followsChanges = { refetchOnChange: true } as const;

// @approved
//  Every committed database change revalidates the open reads that follow
// changes. Only reads that show background work opt in: a read that also
// supplies the revision a later command is sent at keeps its own refresh, so
// a confirmation or draft still conflicts with a change made after it was
// read. The stream opens before the first render and announces the current
// change on every connect, so a reconnect revalidates too. A read whose bytes
// did not change answers 304.
export const followServerChanges = (client: QueryClient) => {
	const source = new EventSource("/api/changes");
	const cache = client.getQueryCache();
	const follows = (query: Query) => query.meta?.refetchOnChange === true;
	// @approved
	//  A read in flight may have read before the change, and refetching would
	// cancel it, so a read slower than the changes arriving would never land:
	// it finishes, then reads once more.
	const again = new Set<string>();
	cache.subscribe((event) => {
		if (event.type !== "updated" || event.query.state.fetchStatus !== "idle" || !again.delete(event.query.queryHash)) return;
		void client.invalidateQueries({ queryKey: event.query.queryKey, exact: true, type: "active" });
	});
	source.addEventListener("change", () => {
		for (const query of cache.findAll({ type: "active", predicate: follows })) {
			if (query.state.fetchStatus === "fetching") again.add(query.queryHash);
			else void client.invalidateQueries({ queryKey: query.queryKey, exact: true });
		}
	});
	return () => source.close();
};
