import { test, expect } from "./fixtures";

test("Settings shares manual checks and keeps update instructions after a failed refresh", async ({ page, llm, context }) => {
	const revision = "a".repeat(40);
	await llm.updates({ build: { distribution: "official", buildNumber: 9, revision }, automaticChecks: false, replies: [{ buildNumber: 10, revision, hold: true }, { status: 503 }] });
	await page.goto("/");
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(page.getByText("Not checked", { exact: true })).toBeVisible();
	const other = await context.newPage();
	await other.goto("/");
	await other.getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByRole("button", { name: "Check now", exact: true }).click();
	await expect(other.getByText("Checking…", { exact: true })).toBeVisible();
	await llm.release();
	await expect(page.getByText("Build 10 available", { exact: true })).toBeVisible();
	await expect(other.getByText("Build 10 available", { exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Update instructions" })).toHaveAttribute("href", "https://github.com/TanJeeSchuan/DitzyTavern/blob/master/docs/docker.md#updates-and-backups");
	await expect(page.getByRole("link", { name: "View changes" })).toHaveCount(0);
	await other.getByRole("button", { name: "Check now", exact: true }).click();
	await expect(page.getByText("Last refresh failed", { exact: false })).toBeVisible();
	await expect(page.getByText("Build 10 available", { exact: true })).toBeVisible();
	await expect(page.getByText("Last successful check", { exact: false })).toBeVisible();
	expect((await llm.log()).registryCalls).toHaveLength(4);
	await other.close();
});

test("Settings retries an initial failure and shows changes only for a newer differing revision", async ({ page, llm }) => {
	const revision = "a".repeat(40);
	await llm.updates({ build: { distribution: "official", buildNumber: 9, revision }, automaticChecks: false, replies: [{ status: 503 },
		{ buildNumber: 9, revision }, { buildNumber: 8, revision }, { buildNumber: 10, revision: "b".repeat(40) }] });
	await page.goto("/");
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByRole("button", { name: "Check now", exact: true }).click();
	await expect(page.getByText("Couldn't check for updates", { exact: true })).toBeVisible();
	await expect(page.getByText("Up to date", { exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(page.getByText("Up to date", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Check now", exact: true }).click();
	await expect(page.getByText("No newer build available · running build 9, published build 8", { exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Update instructions" })).toHaveCount(0);
	await page.getByRole("button", { name: "Check now", exact: true }).click();
	await expect(page.getByRole("link", { name: "View changes" })).toHaveAttribute("href", `https://github.com/TanJeeSchuan/DitzyTavern/compare/${revision}...${"b".repeat(40)}`);
});

test("custom builds show unavailable checks in narrow Settings without registry access", async ({ page, llm, request }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/");
	await page.getByRole("button", { name: "Open navigation" }).click();
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(page.getByText("Custom build · update checks unavailable", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Check now", exact: true })).toHaveCount(0);
	await request.post("/api/updates/check");
	expect((await llm.log()).registryCalls).toEqual([]);
});

test("server restart cancels an in-flight refresh and clears the cached comparison", async ({ page, llm, context }) => {
	const revision = "a".repeat(40);
	await llm.updates({ build: { distribution: "official", buildNumber: 9, revision }, automaticChecks: false, replies: [{ buildNumber: 10, revision }, { buildNumber: 11, revision, hold: true }] });
	await page.goto("/");
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByRole("button", { name: "Check now", exact: true }).click();
	await expect(page.getByText("Build 10 available", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Check now", exact: true }).click();
	await expect(page.getByText("Checking…", { exact: true })).toBeVisible();
	await page.close();
	await llm.restart("graceful");
	const reopened = await context.newPage();
	await reopened.goto("/");
	await reopened.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(reopened.getByText("Not checked", { exact: true })).toBeVisible();
	await expect(reopened.getByText("Build 10 available", { exact: true })).toHaveCount(0);
	await reopened.close();
});

for (const mode of ["crash", "graceful"] as const) test(`Settings controls shared automatic checks and retains the preference after ${mode} restart`, async ({ page, llm, context }) => {
	const revision = "a".repeat(40);
	await llm.updates({ build: { distribution: "official", buildNumber: 9, revision }, replies: [{ buildNumber: 10, revision, hold: true },
		{ buildNumber: 11, revision }, { buildNumber: 12, revision }] });
	await page.goto("/");
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const toggle = page.getByRole("switch", { name: "Automatic update checks" });
	await expect(toggle).toBeChecked();
	await expect(page.getByText("Checking…", { exact: true })).toBeVisible();
	const other = await context.newPage();
	await other.goto("/");
	await other.getByRole("button", { name: "Settings", exact: true }).click();
	await toggle.click();
	await expect(other.getByRole("switch", { name: "Automatic update checks" })).not.toBeChecked();
	await llm.release();
	await expect(other.getByText("Build 10 available", { exact: true })).toBeVisible();
	expect((await llm.log()).registryCalls).toHaveLength(2);
	await other.getByRole("switch", { name: "Automatic update checks" }).click();
	await expect(toggle).toBeChecked();
	await expect(page.getByText("Build 11 available", { exact: true })).toBeVisible();
	await toggle.click();
	await expect(other.getByRole("switch", { name: "Automatic update checks" })).not.toBeChecked();
	await expect(page.getByText("Build 11 available", { exact: true })).toBeVisible();
	await page.close();
	await other.close();
	await llm.restart(mode);
	const reopened = await context.newPage();
	await reopened.goto("/");
	await reopened.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(reopened.getByRole("switch", { name: "Automatic update checks" })).not.toBeChecked();
	await expect(reopened.getByText("Not checked", { exact: true })).toBeVisible();
	expect((await llm.log()).registryCalls).toHaveLength(0);
	await reopened.getByRole("button", { name: "Check now", exact: true }).click();
	await expect(reopened.getByText("Build 12 available", { exact: true })).toBeVisible();
	await reopened.close();
});
