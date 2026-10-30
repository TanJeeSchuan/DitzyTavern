import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { Elysia } from "elysia";
import { createContract } from ".";
import { contentValidators } from "./content-validators";

let database: Database;
beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
afterEach(() => { database.close(); });

const get = (path: string, etag?: string) =>
	createContract(database).handle(new Request(`http://localhost${path}`, { headers: etag === undefined ? {} : { "if-none-match": etag } }));

test("a read answers its own validator with an empty 304, and a changed read with its new bytes", async () => {
	const first = await get("/api/workspace");
	const etag = first.headers.get("etag")!;
	expect(first.headers.get("cache-control")).toBe("no-cache");
	const repeated = await get("/api/workspace", etag.replace(/^W\//, ""));
	expect(repeated.status).toBe(304);
	expect(await repeated.text()).toBe("");
	database.run("INSERT INTO character (name) VALUES ('Maren')");
	const changed = await get("/api/workspace", etag);
	expect(changed.status).toBe(200);
	expect(changed.headers.get("etag")).not.toBe(etag);
	expect((await changed.json()).characters).toEqual([expect.objectContaining({ name: "Maren" })]);
});

test("an error answer carries no validator", async () => {
	const missing = await get("/api/conversations/404");
	expect(missing.status).toBe(404);
	expect(missing.headers.get("etag")).toBeNull();
});

test("a validated answer keeps repeated headers apart", async () => {
	const app = new Elysia().use(contentValidators).get("/api/boxes/jar/visit", ({ set }) => {
		Object.assign(set.headers, { "set-cookie": ["a=1; Path=/", "b=2; Path=/"] });
		return { visited: true };
	});
	const answer = await app.handle(new Request("http://localhost/api/boxes/jar/visit"));
	expect(answer.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
	expect(answer.headers.get("etag")).not.toBeNull();
});
