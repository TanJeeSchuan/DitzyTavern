import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { watchDatabaseChanges } from "../database/changes";
import { createContract } from ".";

let database: Database;
let stop: () => void;
beforeEach(() => {
	database = openInitializedDatabase({ path: ":memory:" });
	stop = watchDatabaseChanges(database, 5);
});
afterEach(() => {
	stop();
	database.close();
});

test("the change stream sends each change as an event a browser dispatches, and ends when the watch stops", async () => {
	const response = await createContract(database).handle(new Request("http://localhost/api/changes"));
	expect(response.headers.get("content-type")).toContain("text/event-stream");
	const reader = response.body!.getReader(); // @approved A stream route always answers a body.
	const next = async () => {
		let text = "";
		while (!text.includes("\n\n")) text += Buffer.from((await reader.read()).value ?? []).toString();
		return text;
	};
	expect(await next()).toBe('event: change\ndata: {"seq":0}\n\n');
	database.run("INSERT INTO character (name) VALUES ('Maren')");
	expect(await next()).toBe('event: change\ndata: {"seq":1}\n\n');
	stop();
	expect((await reader.read()).done).toBe(true);
});
