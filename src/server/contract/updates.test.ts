import { openInitializedDatabase } from "../database/database";
import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { createUpdateChecker } from "../updates";
import { createUpdateRoutes } from "./updates";

let database: ReturnType<typeof openInitializedDatabase>;
beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
afterEach(() => { jest.useRealTimers(); database.close(); });

test("HTTP commands and subscribers observe one server-wide update result", async () => {
	let requests = 0;
	const pending = Promise.withResolvers<Response>();
	const checker = createUpdateChecker(database, { build: { distribution: "official", buildNumber: 9, revision: "a".repeat(40) }, registryFetch: async () => ++requests === 1 ? pending.promise : Response.json({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", annotations: { "io.ditzytavern.distribution": "official", "io.ditzytavern.build-number": "10", "org.opencontainers.image.revision": "b".repeat(40) } }) });
	const app = createUpdateRoutes(checker);
	const abort = new AbortController();
	const subscription = await app.handle(new Request("http://localhost/api/updates/events", { signal: abort.signal }));
	expect(subscription.headers.get("content-type")).toContain("text/event-stream");
	const reader = subscription.body!.getReader();
	const read = async () => new TextDecoder().decode((await reader.read()).value);
	expect(await read()).toContain('"result":null,"attempt":null');
	expect(requests).toBe(0);
	const first = app.handle(new Request("http://localhost/api/updates/check", { method: "POST" }));
	expect(await read()).toContain('"status":"checking"');
	const second = app.handle(new Request("http://localhost/api/updates/check", { method: "POST" }));
	pending.resolve(Response.json({ token: "anonymous" }));
	expect(await (await first).json()).toMatchObject({ result: { comparison: "update_available", buildNumber: 10 } });
	expect(await (await second).json()).toMatchObject({ result: { comparison: "update_available", buildNumber: 10 } });
	expect(await read()).toContain('"comparison":"update_available"');
	expect(requests).toBe(2);
	abort.abort();
	expect((await reader.read()).done).toBe(true);
	expect(await (await app.handle(new Request("http://localhost/api/updates"))).json()).toMatchObject({ result: { comparison: "update_available" } });
});

test("automatic-check commands publish the installation preference to every client", async () => {
	const checker = createUpdateChecker(database);
	const app = createUpdateRoutes(checker);
	const subscription = await app.handle(new Request("http://localhost/api/updates/events"));
	const reader = subscription.body!.getReader();
	const read = async () => new TextDecoder().decode((await reader.read()).value);
	expect(await read()).toContain('"automaticChecks":true');
	const changed = await app.handle(new Request("http://localhost/api/updates/automatic", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) }));
	expect(changed.status).toBe(200);
	expect(await changed.json()).toMatchObject({ automaticChecks: false });
	expect(await read()).toContain('"automaticChecks":false');
	expect(await (await app.handle(new Request("http://localhost/api/updates"))).json()).toMatchObject({ automaticChecks: false });
	await reader.cancel();
	await checker.stop();
});

test("idle update subscriptions send SSE comments before the server timeout without checking the registry", async () => {
	jest.useFakeTimers();
	let requests = 0;
	const checker = createUpdateChecker(database, { build: { distribution: "official", buildNumber: 9, revision: "a".repeat(40) }, registryFetch: async () => { requests++; return Response.json({}); } });
	checker.setAutomaticChecks(false);
	const subscription = await createUpdateRoutes(checker).handle(new Request("http://localhost/api/updates/events"));
	const reader = subscription.body!.getReader();
	expect(new TextDecoder().decode((await reader.read()).value)).toContain('"automaticChecks":false');
	const frames: string[] = [];
	const next = reader.read().then(({ value }) => frames.push(new TextDecoder().decode(value)));
	try {
		jest.advanceTimersByTime(5_000);
		await Promise.resolve();
		expect(frames).toEqual([": keep-alive\n\n"]);
		expect(requests).toBe(0);
	} finally { await reader.cancel(); await next; await checker.stop(); }
});

test("SSE comments keep an idle HTTP subscription connected across the server idle timeout", async () => {
	const checker = createUpdateChecker(database);
	const app = createUpdateRoutes(checker).listen({ hostname: "127.0.0.1", port: 0, idleTimeout: 9 });
	try {
		const subscription = await fetch(new URL("/api/updates/events", app.server!.url), { signal: AbortSignal.timeout(20_000) });
		const reader = subscription.body!.getReader();
		await reader.read();
		for (let i = 0; i < 3; i++) {
			expect(new TextDecoder().decode((await reader.read()).value)).toBe(": keep-alive\n\n");
		}
		checker.setAutomaticChecks(false);
		expect(new TextDecoder().decode((await reader.read()).value)).toContain('"automaticChecks":false');
		await reader.cancel();
	} finally { await checker.stop(); await app.stop(true); }
}, 21_000);

for (const ending of ["abort", "cancel", "shutdown"] as const) test(`${ending} closes the update subscription and releases its heartbeat`, async () => {
	jest.useFakeTimers();
	const checker = createUpdateChecker(database);
	const abort = new AbortController();
	const subscription = await createUpdateRoutes(checker).handle(new Request("http://localhost/api/updates/events", { signal: abort.signal }));
	const reader = subscription.body!.getReader();
	await reader.read();
	if (ending === "abort") abort.abort();
	else if (ending === "cancel") await reader.cancel();
	else await checker.stop();
	expect((await reader.read()).done).toBe(true);
	expect(jest.getTimerCount()).toBe(0);
	checker.setAutomaticChecks(false);
	jest.advanceTimersByTime(30_000);
	expect((await reader.read()).done).toBe(true);
	await checker.stop();
});

test("subscribing after checker shutdown closes immediately without a heartbeat", async () => {
	jest.useFakeTimers();
	const checker = createUpdateChecker(database);
	await checker.stop();
	const subscription = await createUpdateRoutes(checker).handle(new Request("http://localhost/api/updates/events"));
	expect((await subscription.body!.getReader().read()).done).toBe(true);
	expect(jest.getTimerCount()).toBe(0);
});
