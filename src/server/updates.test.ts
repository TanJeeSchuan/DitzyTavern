import { openInitializedDatabase } from "./database/database";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createUpdateChecker } from "./updates";

let database: ReturnType<typeof openInitializedDatabase>;
beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
afterEach(() => database.close());

const revision = "a".repeat(40);
const official = { distribution: "official", buildNumber: 9, revision } as const;
const index = (buildNumber: string, source = revision) => Response.json({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json",
	annotations: { "io.ditzytavern.distribution": "official", "io.ditzytavern.build-number": buildNumber,
	"org.opencontainers.image.revision": source } });
const registry = (...responses: Response[]) => async () => responses.shift() ?? Response.json({ token: "anonymous" });

test("build 10 is available to build 9 even at the same source revision", async () => {
	const checker = createUpdateChecker(database, { build: official, registryFetch: registry(Response.json({ token: "anonymous" }), index("10")) });
	expect(checker.get()).toMatchObject({ automaticChecks: true, attempt: null, result: null });
	expect(await checker.check()).toMatchObject({ result: { comparison: "update_available", buildNumber: 10, revision }, attempt: { status: "succeeded" } });
});

test("anonymous registry access reads only the latest index with bounded requests", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const responses = [Response.json({ token: "public-pull" }), index("10")];
	const checker = createUpdateChecker(database, { build: official, registryFetch: async (url, init) => { requests.push({ url, init }); return responses.shift()!; } });
	await checker.check();
	expect(requests.map(({ url }) => url)).toEqual(["https://ghcr.io/token?service=ghcr.io&scope=repository:tanjeeschuan/ditzytavern:pull",
		"https://ghcr.io/v2/tanjeeschuan/ditzytavern/manifests/latest"]);
	expect(new Headers(requests[1].init?.headers).get("authorization")).toBe("Bearer public-pull");
	expect(requests.every(({ init }) => init?.signal instanceof AbortSignal)).toBe(true);
});

test("custom builds stay unavailable even after a manual check", async () => {
	let requests = 0;
	const checker = createUpdateChecker(database, { build: { distribution: "custom", buildNumber: null, revision: null },
		registryFetch: async () => { requests++; throw new Error("Outbound request forbidden"); } });
	checker.start();
	checker.setAutomaticChecks(false);
	checker.setAutomaticChecks(true);
	expect(await checker.check()).toEqual({ build: { distribution: "custom", buildNumber: null, revision: null }, automaticChecks: true, attempt: null, result: null });
	expect(requests).toBe(0);
	await checker.stop();
});
test("equal and smaller published numbers never offer an update", async () => {
 for (const [number, comparison] of [["9", "current"], ["8", "ahead"]] as const) {
  const checker = createUpdateChecker(database, { build: official, registryFetch: registry(Response.json({ token: "anonymous" }), index(number, "b".repeat(40))) });
  expect(await checker.check()).toMatchObject({ result: { comparison, buildNumber: Number(number) } });
 }
});
test("an initial registry failure reports no successful comparison", async () => {
 const checker = createUpdateChecker(database, { build: official, registryFetch: registry(new Response("Denied", { status: 503 })) });
 expect(await checker.check()).toMatchObject({ result: null, attempt: { status: "failed", error: "Registry authentication failed (503)." } });
});
test("invalid official index metadata cannot claim currency", async () => {
 for (const response of [index("0"), index("1.5"), index("9007199254740992"), index("9", "short"), Response.json({ annotations: {} }),
 	Response.json({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", annotations: { "io.ditzytavern.distribution": "official",
 	"io.ditzytavern.build-number": "9", "org.opencontainers.image.revision": revision } })]) {
  const checker = createUpdateChecker(database, { build: official, registryFetch: registry(Response.json({ token: "anonymous" }), response) });
  expect(await checker.check()).toMatchObject({ result: null, attempt: { status: "failed", error: "Published index has invalid official build metadata." } });
 }
});
test("a failed refresh retains the successful comparison and check time", async () => {
 for (const number of ["8", "9", "10"]) {
  const checker = createUpdateChecker(database, { build: official, registryFetch: registry(Response.json({ token: "anonymous" }), index(number), new Response("", { status: 503 })) });
  const success = await checker.check();
  expect(await checker.check()).toMatchObject({ result: success.result, attempt: { status: "failed" } });
 }
});
test("concurrent checks share the pending request and expose checking to observers", async () => {
 const pending = Promise.withResolvers<Response>();
 let requests = 0;
 const checker = createUpdateChecker(database, { build: official, registryFetch: async () => ++requests === 1 ? pending.promise : index("10") });
 const first = checker.check();
 const second = checker.check();
 expect(checker.get()).toMatchObject({ result: null, attempt: { status: "checking" } });
 expect(second).toBe(first);
 pending.resolve(Response.json({ token: "anonymous" }));
 expect(await second).toMatchObject({ result: { comparison: "update_available" } });
 expect(requests).toBe(2);
});

test("stopping a checker cancels registry work and ends state subscriptions", async () => {
	const entered = Promise.withResolvers<void>();
	const checker = createUpdateChecker(database, { build: official, registryFetch: async (_url, init) => {
		entered.resolve();
		return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
	} });
	let updates = 0;
	let closed = false;
	checker.subscribe(() => updates++, () => { closed = true; });
	const attempt = checker.check();
	await entered.promise;
	await checker.stop();
	await attempt;
	expect(closed).toBe(true);
	expect(updates).toBe(2);
	expect(await checker.check()).toMatchObject({ result: null, attempt: { status: "failed" } });
});
