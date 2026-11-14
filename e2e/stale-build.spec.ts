import { test, expect, openBoxes } from "./fixtures";

test.use({ allowedBrowserErrors: /status of 404/ });

const memoryRow = async (page: Parameters<typeof openBoxes>[0]) => (await openBoxes(page)).getByRole("listitem").filter({ hasText: "Memory" });

test("a tab that boots a build the server replaced reloads into the current one", async ({ page }) => {
	let stale = true;
	await page.route("**/boxes/memory/client.js", (route) => stale ? route.fulfill({ status: 404 }) : route.fallback());
	await page.route("**/assets/index-*.js", (route) => {
		if (route.request().method() !== "HEAD") return route.fallback();
		stale = false;
		return route.fulfill({ status: 404 });
	});
	await page.goto("/");
	const memory = await memoryRow(page);
	await expect(memory).toBeVisible();
	await expect(memory).not.toContainText("Did not load");
	expect(stale).toBe(false);
});

test("a Box that fails while the build probe stalls still lets the app render", async ({ page }) => {
	await page.route("**/boxes/memory/client.js", (route) => route.fulfill({ status: 404 }));
	await page.route("**/assets/index-*.js", (route) => route.request().method() === "HEAD" ? undefined : route.fallback());
	await page.goto("/");
	await expect(await memoryRow(page)).toContainText("Did not load");
});
