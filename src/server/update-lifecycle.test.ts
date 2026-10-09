import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInitializedDatabase } from "./database/database";
import { createUpdateChecker } from "./updates";

const official = { distribution: "official", buildNumber: 9, revision: "a".repeat(40) } as const;

function clock() {
	let now = 0;
	const jobs = new Set<{ callback: () => void; interval: number; next: number }>();
	return {
		scheduleInterval: (callback: () => void, interval: number) => {
			const job = { callback, interval, next: now + interval };
			jobs.add(job);
			return () => { jobs.delete(job); };
		},
		advance: (duration: number) => {
			now += duration;
			for (const job of jobs) while (job.next <= now && jobs.has(job)) { job.next += job.interval; job.callback(); }
		},
	};
}

test("an enabled official server checks at startup and every 24 hours until shutdown", async () => {
	const database = openInitializedDatabase({ path: ":memory:" });
	const time = clock();
	let number = 9;
	const checker = createUpdateChecker(database, { build: official, scheduleInterval: time.scheduleInterval,
		registryFetch: async (url) => url.includes("/token?") ? Response.json({ token: "anonymous" }) : Response.json({ schemaVersion: 2,
		mediaType: "application/vnd.oci.image.index.v1+json", annotations: { "io.ditzytavern.distribution": "official",
		"io.ditzytavern.build-number": String(++number), "org.opencontainers.image.revision": official.revision } }) });
	try {
		checker.start();
		checker.start();
		expect(checker.get().attempt?.status).toBe("checking");
		await checker.check();
		expect(checker.get().result?.buildNumber).toBe(10);
		time.advance(86_399_999);
		expect(checker.get().result?.buildNumber).toBe(10);
		time.advance(1);
		expect(checker.get().attempt?.status).toBe("checking");
		await checker.check();
		expect(checker.get().result?.buildNumber).toBe(11);
		time.advance(86_400_000);
		expect(checker.get().attempt?.status).toBe("checking");
		await checker.check();
		expect(checker.get().result?.buildNumber).toBe(12);
		await checker.stop();
		time.advance(86_400_000);
		expect(checker.get().result?.buildNumber).toBe(12);
	} finally { await checker.stop(); database.close(); }
});

test("custom servers make no registry requests at startup, on preference changes, or after 24 hours", async () => {
	const database = openInitializedDatabase({ path: ":memory:" });
	const time = clock();
	let requests = 0;
	const checker = createUpdateChecker(database, { build: { distribution: "custom", buildNumber: null, revision: null },
		scheduleInterval: time.scheduleInterval, registryFetch: async () => { requests++; throw new Error("No custom registry access"); } });
	try {
		checker.start();
		checker.setAutomaticChecks(false);
		checker.setAutomaticChecks(true);
		time.advance(172_800_000);
		await checker.check();
		expect(checker.get()).toMatchObject({ automaticChecks: true, result: null, attempt: null });
		expect(requests).toBe(0);
	} finally { await checker.stop(); database.close(); }
});

test("automatic-check preference survives reopening while comparison and attempt state clear", async () => {
	const directory = mkdtempSync(join(tmpdir(), "ditzy-updates-"));
	const path = join(directory, "data.sqlite");
	let database = openInitializedDatabase({ path });
	try {
		const checker = createUpdateChecker(database, { build: official,
			registryFetch: async (url) => url.includes("/token?") ? Response.json({ token: "anonymous" }) : Response.json({ schemaVersion: 2,
			mediaType: "application/vnd.oci.image.index.v1+json", annotations: { "io.ditzytavern.distribution": "official",
			"io.ditzytavern.build-number": "10", "org.opencontainers.image.revision": "b".repeat(40) } }) });
		expect(checker.get().automaticChecks).toBe(true);
		checker.setAutomaticChecks(false);
		await checker.check();
		expect(checker.get().result?.buildNumber).toBe(10);
		await checker.stop();
		database.close();
		database = openInitializedDatabase({ path });
		const reopened = createUpdateChecker(database, { build: official });
		expect(reopened.get()).toMatchObject({ automaticChecks: false, result: null, attempt: null });
		await reopened.stop();
	} finally { database.close(); try { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {} }
});

test("disabled servers skip startup, enabling checks immediately, and disabling retains manual checking", async () => {
	const database = openInitializedDatabase({ path: ":memory:" });
	const time = clock();
	let requests = 0;
	const pending = Promise.withResolvers<Response>();
	const checker = createUpdateChecker(database, { build: official, scheduleInterval: time.scheduleInterval, registryFetch: async (url) => {
		requests++;
		if (requests === 1) return pending.promise;
		return url.includes("/token?") ? Response.json({ token: "anonymous" }) : Response.json({ schemaVersion: 2,
			mediaType: "application/vnd.oci.image.index.v1+json", annotations: { "io.ditzytavern.distribution": "official",
			"io.ditzytavern.build-number": "10", "org.opencontainers.image.revision": official.revision } });
	} });
	try {
		checker.setAutomaticChecks(false);
		checker.start();
		time.advance(86_400_000);
		expect(checker.get()).toMatchObject({ automaticChecks: false, result: null, attempt: null });
		expect(requests).toBe(0);
		checker.setAutomaticChecks(true);
		expect(checker.get().attempt?.status).toBe("checking");
		const manual = checker.check();
		checker.setAutomaticChecks(true);
		expect(requests).toBe(1);
		checker.setAutomaticChecks(false);
		pending.resolve(Response.json({ token: "anonymous" }));
		await manual;
		expect(checker.get()).toMatchObject({ automaticChecks: false, result: { buildNumber: 10 } });
		time.advance(172_800_000);
		expect(requests).toBe(2);
		await checker.check();
		expect(requests).toBe(4);
	} finally { await checker.stop(); database.close(); }
});
