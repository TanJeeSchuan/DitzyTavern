import { Elysia } from "elysia";
import { automaticUpdateChecksCommand, updateStatus } from "../../shared/contract/updates";
import type { UpdateChecker } from "../updates";

function subscribe(checker: UpdateChecker, request: Request) {
	const encoder = new TextEncoder();
	let unsubscribe: (() => void) | undefined;
	let removeAbort: (() => void) | undefined;
	let closed = false;
	const cleanup = () => { unsubscribe?.(); removeAbort?.(); };
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const abort = () => { if (closed) return; closed = true; cleanup(); controller.close(); };
			unsubscribe = checker.subscribe((state) => controller.enqueue(encoder.encode(`event: status\ndata: ${JSON.stringify(state)}\n\n`)), abort);
			removeAbort = () => request.signal.removeEventListener("abort", abort);
			if (closed) cleanup();
			else if (request.signal.aborted) abort();
			else request.signal.addEventListener("abort", abort, { once: true });
		},
		cancel: () => { closed = true; cleanup(); },
	});
	return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" } });
}

export const createUpdateRoutes = (checker: UpdateChecker) => new Elysia()
	.get("/api/updates", () => checker.get(), { response: updateStatus })
	.post("/api/updates/check", () => checker.check(), { response: updateStatus })
	.post("/api/updates/automatic", ({ body }) => checker.setAutomaticChecks(body.enabled), { body: automaticUpdateChecksCommand, response: updateStatus })
	.get("/api/updates/events", ({ request }) => subscribe(checker, request));
