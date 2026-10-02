import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { openInitializedDatabase } from "../database/database";
import { shutdownApplication } from "./shutdown";

test("shutdown starts worker cancellation while joining HTTP handlers and closes the database last", async () => {
	const database = openInitializedDatabase({ path: ":memory:" });
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const app = new Elysia().get("/pending", async () => {
		entered.resolve();
		await release.promise;
		return database.query("SELECT 1 AS value").get();
	}).listen({ hostname: "127.0.0.1", port: 0 });
	const response = fetch(new URL("pending", app.server!.url));
	await entered.promise;
	let workerCancelled = false;
	const shutdown = shutdownApplication(database, async () => { await app.stop(); }, async () => { workerCancelled = true; });
	try {
		expect(workerCancelled).toBe(true);
		expect(database.query("SELECT 1 AS value").get()).toEqual({ value: 1 });
		release.resolve();
		expect(await (await response).json()).toEqual({ value: 1 });
		await shutdown;
		expect(() => database.query("SELECT 1").get()).toThrow();
	} finally {
		release.resolve();
		await shutdown;
	}
});

test("one process deadline bounds unfinished HTTP, worker, and generation work without closing their database", async () => {
	const child = Bun.spawn([process.execPath, "--eval", `
		import { Elysia } from "elysia";
		import { openInitializedDatabase } from ${JSON.stringify(new URL("../database/database.ts", import.meta.url).href)};
		import { generationRuntimeFor } from ${JSON.stringify(new URL("../workflows/generation-runtime.ts", import.meta.url).href)};
		import { shutdownApplication } from ${JSON.stringify(new URL("./shutdown.ts", import.meta.url).href)};
		const database = openInitializedDatabase({ path: ":memory:" });
		database.close = () => { throw new Error("Closed while work was still running"); };
		const pending = new Promise(() => {});
		const registry = generationRuntimeFor(database);
		registry.track(pending);
		const runtime = registry.start({ generationId: 1, conversationId: 1, messageId: 1, variantId: 1,
			startedAt: new Date().toISOString(), checkpoint: { eventInterval: 99, intervalMs: 0 },
			onCheckpoint: ({ content }) => console.log("checkpoint:" + content),
			onStop: () => console.log("provider cancelled") });
		runtime.publish({ type: "content", text: "retained output" });
		const entered = Promise.withResolvers();
		const app = new Elysia().get("/pending", () => { entered.resolve(); return pending; }).listen({ hostname: "127.0.0.1", port: 0 });
		void fetch(new URL("pending", app.server.url));
		await entered.promise;
		await shutdownApplication(database, async () => { await app.stop(); }, () => { console.log("worker cancelled"); return pending; });
		console.log("unexpected graceful completion");
	`], { stdout: "pipe", stderr: "pipe" });
	try {
		const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		expect(code).toBe(1);
		expect(stdout).toContain("checkpoint:retained output");
		expect(stdout).toContain("provider cancelled");
		expect(stdout).toContain("worker cancelled");
		expect(stdout).not.toContain("unexpected graceful completion");
		expect(stderr).toContain("Work did not finish within five seconds");
		expect(stderr).not.toContain("Closed while work was still running");
	} finally {
		child.kill();
	}
}, 10_000);
