import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInitializedDatabase } from "./database";

const pageSize = (database: ReturnType<typeof openInitializedDatabase>): number =>
	database.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size ?? 0;

const pageCount = (database: ReturnType<typeof openInitializedDatabase>): number =>
	database.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count ?? 0;

const freePages = (database: ReturnType<typeof openInitializedDatabase>): number =>
	database.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()?.freelist_count ?? 0;

test("reclaims the dead pages a previous open left behind, and only those", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ditzy-reclaim-"));
	const path = join(directory, "app.sqlite");
	try {
		const seeded = openInitializedDatabase({ path });
		seeded.exec("CREATE TABLE churn (payload BLOB)");
		seeded.exec("INSERT INTO churn (payload) VALUES (zeroblob(34000000))");
		seeded.exec("DELETE FROM churn");
		const deadPages = freePages(seeded);
		const pagesBefore = pageCount(seeded);
		expect(deadPages * pageSize(seeded)).toBeGreaterThanOrEqual(32 * 1024 * 1024);
		seeded.close();

		const reclaimed = openInitializedDatabase({ path });
		expect(freePages(reclaimed)).toBe(0);
		expect(pageCount(reclaimed)).toBeLessThan(pagesBefore);
		expect(pageCount(reclaimed)).toBeGreaterThan(0);
		reclaimed.exec("INSERT INTO churn (payload) VALUES (zeroblob(4096))");
		reclaimed.exec("DELETE FROM churn");
		const pagesWithSmallDebt = pageCount(reclaimed);
		reclaimed.close();

		const reopened = openInitializedDatabase({ path });
		expect(freePages(reopened)).toBeGreaterThan(0);
		expect(pageCount(reopened)).toBe(pagesWithSmallDebt);
		reopened.close();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
