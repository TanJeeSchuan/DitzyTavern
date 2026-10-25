import { expect, spyOn, test } from "bun:test";
import { openInitializedDatabase } from "../database/database";
import { createContract } from "./index";

test("Elysia mirrors every route schema without falling back", () => {
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	const database = openInitializedDatabase({ path: ":memory:" });
	try {
		for (const route of createContract(database).routes) route.compile();
		expect(warn).not.toHaveBeenCalled();
	} finally {
		warn.mockRestore();
		database.close();
	}
});
