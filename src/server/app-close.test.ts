import { expect, test } from "bun:test";
import { createApp } from "./app";
import { openInitializedDatabase } from "./database/database";

test("concurrent and repeated application close calls join one shutdown", async () => {
	const database = openInitializedDatabase({ path: ":memory:" });
	const { close } = await createApp({ database });
	const release = Promise.withResolvers<void>();
	let stops = 0;
	const stopHttp = async () => { stops++; await release.promise; };
	const first = close(stopHttp);
	const second = close(stopHttp);
	release.resolve();
	await Promise.all([first, second]);
	expect(stops).toBe(1);
	await close(stopHttp);
	expect(stops).toBe(1);
});
