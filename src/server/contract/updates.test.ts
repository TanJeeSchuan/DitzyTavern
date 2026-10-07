import { expect, test } from "bun:test";
import { createUpdateChecker } from "../updates";
import { createUpdateRoutes } from "./updates";

test("HTTP commands and subscribers observe one server-wide update result", async () => {
	let requests = 0;
	const pending = Promise.withResolvers<Response>();
	const checker = createUpdateChecker({ build: { distribution: "official", buildNumber: 9, revision: "a".repeat(40) }, registryFetch: async () => ++requests === 1 ? pending.promise : Response.json({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", annotations: { "io.ditzytavern.distribution": "official", "io.ditzytavern.build-number": "10", "org.opencontainers.image.revision": "b".repeat(40) } }) });
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
