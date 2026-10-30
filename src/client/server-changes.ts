import type { QueryClient } from "@tanstack/react-query";

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
	source.addEventListener("change", () => {
		void client.invalidateQueries({ type: "active", predicate: (query) => query.meta?.refetchOnChange === true });
	});
	return () => source.close();
};
