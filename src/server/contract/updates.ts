import { Elysia, sse } from "elysia";
import { automaticUpdateChecksCommand, updateStatus } from "../../shared/contract/updates";
import type { UpdateChecker } from "../updates";
import { subscriptionEvents } from "./subscription-events";

export const createUpdateRoutes = (checker: UpdateChecker) => new Elysia()
	.get("/api/updates", () => checker.get(), { response: updateStatus })
	.post("/api/updates/check", () => checker.check(), { response: updateStatus })
	.post("/api/updates/automatic", ({ body }) => checker.setAutomaticChecks(body.enabled), { body: automaticUpdateChecksCommand, response: updateStatus })
	.get("/api/updates/events", (context) => subscriptionEvents(context, (emit, close) => {
		const unsubscribe = checker.subscribe((state) => emit(sse({ event: "status", data: state })), close);
		const heartbeat = setInterval(() => emit(new TextEncoder().encode(": keep-alive\n\n")), 5_000);
		return () => { clearInterval(heartbeat); unsubscribe(); };
	}));
