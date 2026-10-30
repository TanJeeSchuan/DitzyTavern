import type { Database } from "bun:sqlite";
import { Elysia, sse } from "elysia";
import { subscribeDatabaseChanges } from "../database/changes";
import { subscriptionEvents } from "./subscription-events";

const HEARTBEAT_MS = 30_000;

// @approved
//  Each committed database change, announced to every open client so its live
// reads revalidate instead of polling. An event carries only the change's
// number: a reader refetches and its validator answers what did not change.
// A proxy closes a quiet stream, so a keep-alive goes out between changes.
export const createChangeRoutes = (database: Database) => new Elysia()
	.get("/api/changes", (context) => subscriptionEvents(context, (emit, close) => {
		const unsubscribe = subscribeDatabaseChanges(database, (seq) => emit(sse({ event: "change", data: { seq } })), close);
		const heartbeat = setInterval(() => emit(new TextEncoder().encode(": keep-alive\n\n")), HEARTBEAT_MS);
		return () => { clearInterval(heartbeat); unsubscribe(); };
	}, { latest: true }));
