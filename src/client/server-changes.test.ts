import { afterEach, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { followServerChanges, followsChanges } from "./server-changes";

class FakeEventSource extends EventTarget {
	static latest: FakeEventSource | undefined;
	constructor(readonly url: string) { super(); FakeEventSource.latest = this; }
	close() {}
}
const original = globalThis.EventSource;
afterEach(() => { Object.assign(globalThis, { EventSource: original }); });

test("a database change refetches the open reads that follow changes, leaving other reads and closed ones", async () => {
	Object.assign(globalThis, { EventSource: FakeEventSource });
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
	const fetched: string[] = [];
	const observe = (key: string, extra = {}) => {
		const observer = new QueryObserver(client, { queryKey: [key], queryFn: async () => { fetched.push(key); return key; }, ...extra });
		return observer.subscribe(() => {});
	};
	observe("digest", { meta: followsChanges });
	observe("draft");
	observe("closed", { meta: followsChanges })();
	await Bun.sleep(0);
	fetched.length = 0;
	followServerChanges(client);
	expect(FakeEventSource.latest?.url).toBe("/api/changes");
	FakeEventSource.latest?.dispatchEvent(new MessageEvent("change", { data: "1" }));
	await Bun.sleep(0);
	expect(fetched).toEqual(["digest"]);
});
